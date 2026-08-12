import fs from "node:fs";
import http, { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeReviewer, reviewTaskWithClaude } from "../agents/claude.js";
import { MaestroConfig } from "../config.js";
import {
  ImprovementCategory,
  ImprovementRisk,
  ImprovementStatus,
  HumanReviewDecision,
  MaestroDatabase
} from "../db.js";
import { ApplicationCommands } from "../commands/application-commands.js";
import { ApplicationCommandError } from "../commands/errors.js";
import { GoalCoordinator } from "../goals/coordinator.js";
import { buildDashboardSnapshot, providerAgentPresence } from "./snapshot.js";
import { ReviewCoordinator } from "../reviews/coordinator.js";
import { BacklogAutopilot } from "../backlog/autopilot.js";
import { redactSensitiveText } from "../security/redaction.js";
import { FeatureCoordinator } from "../features/coordinator.js";
import { FeatureGitHubGateway } from "../features/github.js";
import { EnvironmentDoctor } from "../environment/doctor.js";
import { AgentRegistry } from "../agents/registry.js";
import type { WorkGraphRuntimeCommands, WorkIntakeCommandInput } from "../commands/application-commands.js";
import type { AgentCapability, AgentProviderId } from "../agents/types.js";
import type { ProviderControlUpdate, ProviderMode } from "../agents/policy.js";
import type { SkillLifecycleRuntime } from "../skills/lifecycle.js";
import { SkillCurator } from "../skills/curator.js";
import { OperationalChatService } from "../chat/service.js";

export type DashboardServerOptions = {
  config: MaestroConfig;
  database: MaestroDatabase;
  runtimeMode?: "dashboard" | "full";
  staticRoot?: string;
  claudeReviewer?: ClaudeReviewer;
  goalCoordinator?: GoalCoordinator;
  reviewCoordinator?: ReviewCoordinator;
  featureCoordinator?: Pick<FeatureCoordinator, "reconcile">;
  featureGithub?: FeatureGitHubGateway;
  backlogAutopilot?: Pick<BacklogAutopilot, "snapshot">;
  environmentDoctor?: Pick<EnvironmentDoctor, "inspectProject">;
  agentRegistry?: Pick<AgentRegistry, "snapshot"> & Partial<Pick<
    AgentRegistry,
    "route" | "acquire" | "policySnapshot" | "updateProviderControl" | "updateProviderControls" | "updateCapabilityRouting"
  >>;
  workGraphRuntime?: WorkGraphRuntimeCommands;
  skillLifecycle?: SkillLifecycleRuntime;
  chatService?: OperationalChatService;
};

export function createDashboardServer(options: DashboardServerOptions) {
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const staticRoot = options.staticRoot ?? path.join(moduleRoot, "ui", "dist");
  const commands = new ApplicationCommands(
    options.database,
    options.featureGithub,
    options.workGraphRuntime,
    options.skillLifecycle
  );
  const chatService = options.chatService ?? new OperationalChatService({
    database: options.database,
    agentRegistry: options.agentRegistry,
    commands,
    worktreesRoot: options.config.worktreesPath,
    actionExecutor: options.goalCoordinator
      ? {
          retryTask: (taskId) => { options.goalCoordinator!.start(taskId); },
          resumeGoal: (taskId) => {
            const run = options.database.listActiveGoalRuns().find((r) => r.taskId === taskId);
            if (run?.status === "waiting_provider") {
              options.goalCoordinator!.resume(run.id);
            } else {
              options.goalCoordinator!.start(taskId);
            }
          },
          cancelTask: (taskId) => { options.goalCoordinator!.cancel(taskId); },
          rerunReview: () => { /* reviews are re-attempted by goal runner when task status moves to reviewing */ }
        }
      : undefined
  });

  return http.createServer(async (request, response) => {
    try {
      await routeRequest(request, response, options, staticRoot, commands, chatService);
    } catch (error) {
      console.error("Dashboard request failed:", error instanceof Error ? error.message : "unknown error");
      sendJson(response, 500, { error: "dashboard_request_failed" });
    }
  });
}

export async function startDashboardServer(options: DashboardServerOptions) {
  const server = createDashboardServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.config.dashboard.port, options.config.dashboard.host, () => resolve());
  });
  return server;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: DashboardServerOptions,
  staticRoot: string,
  commands: ApplicationCommands,
  chatService: OperationalChatService
) {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      service: options.config.projectName,
      runtimeMode: options.runtimeMode ?? "dashboard",
      generatedAt: new Date().toISOString()
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    const agents = options.agentRegistry
      ? providerAgentPresence(options.config, options.database, await options.agentRegistry.snapshot())
      : undefined;
    sendJson(response, 200, buildDashboardSnapshot(
      options.config,
      options.database,
      agents,
      options.backlogAutopilot?.snapshot()
    ));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/provider-policy") {
    if (!options.agentRegistry?.policySnapshot) {
      sendJson(response, 503, { error: "provider_policy_unavailable" });
      return;
    }
    sendJson(response, 200, { policy: options.agentRegistry.policySnapshot() });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/provider-policy/providers") {
    if (!options.agentRegistry?.updateProviderControls) {
      sendJson(response, 503, { error: "provider_policy_unavailable" });
      return;
    }
    const body = await readJsonBody(request);
    const controls = Array.isArray(body.controls) ? body.controls : [];
    const validControls: ProviderControlUpdate[] = controls.flatMap((item) => {
      const providerId = readEnum(item?.providerId, ["codex", "claude", "antigravity"] as const);
      const mode = readEnum(item?.mode, ["enabled", "paused", "disabled"] as const);
      return providerId && mode && typeof item?.fallbackEnabled === "boolean"
        ? [{
            providerId: providerId as AgentProviderId,
            mode: mode as ProviderMode,
            fallbackEnabled: item.fallbackEnabled as boolean
          }]
        : [];
    });
    if (validControls.length !== controls.length || validControls.length === 0) {
      sendJson(response, 400, { error: "valid_controls_are_required" });
      return;
    }
    const updated = options.agentRegistry.updateProviderControls(validControls);
    options.database.addEvent({
      source: "dashboard",
      type: "provider.controls_updated",
      text: `${updated.length} provider controls updated atomically.`,
      metadata: { controls: updated }
    });
    sendJson(response, 200, { controls: updated });
    return;
  }

  const providerControlMatch = url.pathname.match(/^\/api\/provider-policy\/providers\/(codex|claude|antigravity)$/);
  if (request.method === "PUT" && providerControlMatch) {
    if (!options.agentRegistry?.updateProviderControl) {
      sendJson(response, 503, { error: "provider_policy_unavailable" });
      return;
    }
    const body = await readJsonBody(request);
    const mode = readEnum(body.mode, ["enabled", "paused", "disabled"] as const);
    if (!mode || typeof body.fallbackEnabled !== "boolean") {
      sendJson(response, 400, { error: "valid_mode_and_fallbackEnabled_are_required" });
      return;
    }
    const control = options.agentRegistry.updateProviderControl({
      providerId: providerControlMatch[1] as AgentProviderId,
      mode: mode as ProviderMode,
      fallbackEnabled: body.fallbackEnabled
    });
    options.database.addEvent({
      source: "dashboard",
      type: "provider.control_updated",
      text: `${control.providerId} set to ${control.mode}.`,
      metadata: { control }
    });
    sendJson(response, 200, { control });
    return;
  }

  const capabilityRoutingMatch = url.pathname.match(/^\/api\/provider-policy\/capabilities\/([a-z_]+)$/);
  if (request.method === "PUT" && capabilityRoutingMatch) {
    if (!options.agentRegistry?.updateCapabilityRouting) {
      sendJson(response, 503, { error: "provider_policy_unavailable" });
      return;
    }
    const capability = readEnum(capabilityRoutingMatch[1], [
      "planning", "coding", "testing", "reviewing", "improvement_reviewing", "research", "conversation"
    ] as const) as AgentCapability | null;
    const body = await readJsonBody(request);
    const order = Array.isArray(body.order)
      ? body.order.filter((item): item is AgentProviderId => ["codex", "claude", "antigravity"].includes(String(item)))
      : [];
    const requiredProviderId = body.requiredProviderId === null
      ? null
      : readEnum(body.requiredProviderId, ["codex", "claude", "antigravity"] as const) as AgentProviderId | null;
    if (!capability || order.length === 0 || (body.requiredProviderId !== null && !requiredProviderId)) {
      sendJson(response, 400, { error: "valid_capability_order_and_requiredProviderId_are_required" });
      return;
    }
    const routing = options.agentRegistry.updateCapabilityRouting({ capability, order, requiredProviderId });
    options.database.addEvent({
      source: "dashboard",
      type: "provider.routing_updated",
      text: `${capability} routing updated.`,
      metadata: { routing }
    });
    sendJson(response, 200, { routing });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/work-graphs") {
    sendJson(response, 200, { workGraphs: commands.listWorkGraphs() });
    return;
  }

  const workGraphMatch = url.pathname.match(/^\/api\/work-graphs\/(\d+)$/);
  if (request.method === "GET" && workGraphMatch) {
    try {
      sendJson(response, 200, { workGraph: commands.getWorkGraph(Number(workGraphMatch[1])) });
    } catch (error) {
      sendCommandError(response, error, "work_graph_get_failed");
    }
    return;
  }

  const cancelWorkGraphMatch = url.pathname.match(/^\/api\/work-graphs\/(\d+)\/cancel$/);
  if (request.method === "POST" && cancelWorkGraphMatch) {
    const body = await readJsonBody(request);
    try {
      const workGraph = await commands.cancelWorkGraph(
        { channel: "dashboard" },
        Number(cancelWorkGraphMatch[1]),
        readString(body.reason) || null
      );
      sendJson(response, 200, { workGraph });
    } catch (error) {
      sendCommandError(response, error, "work_graph_cancel_failed");
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/environment/doctor") {
    if (!options.environmentDoctor) {
      sendJson(response, 503, { error: "environment_doctor_unavailable" });
      return;
    }
    const requestedKey = url.searchParams.get("projectKey")?.trim().toLowerCase();
    const project = requestedKey
      ? options.database.findProjectByKey(requestedKey)
      : options.database.getDefaultProject();
    if (!project) {
      sendJson(response, 404, { error: "project_not_found" });
      return;
    }
    sendJson(response, 200, { report: await options.environmentDoctor.inspectProject(project.key) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/review-queue") {
    if (!options.reviewCoordinator) {
      sendJson(response, 503, { error: "review_coordinator_unavailable" });
      return;
    }
    sendJson(response, 200, { reviews: options.reviewCoordinator.list() });
    return;
  }

  const reviewItemMatch = url.pathname.match(/^\/api\/review-queue\/(\d+)$/);
  if (request.method === "GET" && reviewItemMatch) {
    if (!options.reviewCoordinator) {
      sendJson(response, 503, { error: "review_coordinator_unavailable" });
      return;
    }
    try {
      sendJson(response, 200, { review: options.reviewCoordinator.get(Number(reviewItemMatch[1])) });
    } catch (error) {
      sendJson(response, 404, {
        error: "review_not_found",
        details: error instanceof Error ? error.message : "Unknown review error"
      });
    }
    return;
  }

  const reviewDecisionMatch = url.pathname.match(/^\/api\/review-queue\/(\d+)\/decision$/);
  if (request.method === "POST" && reviewDecisionMatch) {
    if (!options.reviewCoordinator) {
      sendJson(response, 503, { error: "review_coordinator_unavailable" });
      return;
    }
    const body = await readJsonBody(request);
    const decision = readEnum(body.decision, ["approved", "changes_requested", "rejected"]);
    const note = readString(body.note);
    if (!decision || !note) {
      sendJson(response, 400, { error: "decision_and_justification_are_required" });
      return;
    }
    try {
      const result = await options.reviewCoordinator.decide(
        Number(reviewDecisionMatch[1]),
        decision as HumanReviewDecision,
        note,
        "dashboard"
      );
      sendJson(response, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown review decision error";
      sendJson(response, /not found/i.test(message) ? 404 : 409, {
        error: "review_decision_failed",
        details: message
      });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/improvements") {
    sendJson(response, 200, { improvements: options.database.listImprovementProposals() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/improvements") {
    const body = await readJsonBody(request);
    const category = readEnum(body.category, ["skill", "memory", "routing", "policy", "integration"]);
    const risk = readEnum(body.risk, ["low", "medium", "high"]);
    const title = readString(body.title);
    const rationale = readString(body.rationale);
    const proposedChange = readString(body.proposedChange);
    const evidence = Array.isArray(body.evidence)
      ? body.evidence.filter((item): item is string => typeof item === "string")
      : [];

    if (!category || !risk || !title || !rationale || !proposedChange || evidence.length === 0) {
      sendJson(response, 400, { error: "invalid_improvement_proposal" });
      return;
    }

    try {
      const improvement = options.database.createImprovementProposal({
        category: category as ImprovementCategory,
        title,
        rationale,
        proposedChange,
        evidence,
        risk: risk as ImprovementRisk,
        source: "dashboard"
      });
      options.database.addEvent({
        source: "maestro",
        type: "improvement.proposed",
        text: improvement.title,
        metadata: { improvementId: improvement.id, risk: improvement.risk, category: improvement.category }
      });
      sendJson(response, 201, { improvement });
    } catch (error) {
      sendJson(response, 400, {
        error: "invalid_improvement_proposal",
        details: error instanceof Error ? error.message : "Unknown validation error"
      });
    }
    return;
  }

  const improvementDecisionMatch = url.pathname.match(/^\/api\/improvements\/(\d+)\/decision$/);
  if (request.method === "POST" && improvementDecisionMatch) {
    const improvementId = Number(improvementDecisionMatch[1]);
    const body = await readJsonBody(request);
    const status = readEnum(body.status, ["approved", "rejected"]);
    const decisionNote = readString(body.decisionNote) || null;
    if (!status) {
      sendJson(response, 400, { error: "approved_or_rejected_status_required" });
      return;
    }

    try {
      const result = commands.decideImprovementProposal(
        { channel: "dashboard" },
        improvementId,
        status as Exclude<ImprovementStatus, "candidate">,
        decisionNote
      );
      sendJson(response, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown decision error";
      sendJson(response, message.includes("not found") ? 404 : 409, {
        error: "improvement_decision_failed",
        details: message
      });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/skills/proposals") {
    const status = url.searchParams.get("status");
    const allowedStatuses = ["requested", "linked", "rejected"] as const;
    if (status && !(allowedStatuses as readonly string[]).includes(status)) {
      sendJson(response, 400, { error: "invalid_skill_proposal_status" });
      return;
    }
    sendJson(response, 200, {
      proposals: commands.listSkillProposals(status as typeof allowedStatuses[number] | undefined)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/skills/proposals/reconcile") {
    try {
      sendJson(response, 200, { linked: commands.reconcileSkillProposalDrafts({ channel: "dashboard" }) });
    } catch (error) {
      sendCommandError(response, error, "skill_proposal_reconcile_failed");
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/skills/curator/report") {
    const report = new SkillCurator(options.database, {
      staleDays: options.config.skills.curator.staleDays
    }).dryRun();
    sendJson(response, 200, { report });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/skills/curator/apply") {
    try {
      sendJson(response, 200, commands.applySkillCuratorAutomaticArchival({ channel: "dashboard" }));
    } catch (error) {
      sendCommandError(response, error, "skill_curator_apply_failed");
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/skills/curator/candidates") {
    const statusParam = url.searchParams.get("status") as import("../db.js").SkillCuratorCandidateStatus | null;
    const candidates = commands.listSkillCuratorCandidates(statusParam ?? undefined);
    sendJson(response, 200, { candidates });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/skills/curator/candidates/process") {
    try {
      const candidates = commands.processSkillCuratorIncidents({ channel: "dashboard" });
      sendJson(response, 200, { candidates });
    } catch (error) {
      sendCommandError(response, error, "skill_curator_candidates_process_failed");
    }
    return;
  }

  const candidateEvalMatch = url.pathname.match(/^\/api\/skills\/curator\/candidates\/(\d+)\/evaluate$/);
  if (request.method === "POST" && candidateEvalMatch) {
    const candidateId = Number(candidateEvalMatch[1]);
    try {
      const candidate = commands.evaluateSkillCuratorCandidate({ channel: "dashboard" }, candidateId);
      sendJson(response, 200, { candidate });
    } catch (error) {
      sendCommandError(response, error, "skill_curator_candidate_evaluate_failed");
    }
    return;
  }

  const skillVersionActionMatch = url.pathname.match(
    /^\/api\/skills\/versions\/(\d+)\/(evaluate|approve|activate|rollback|restore|archive)$/
  );
  if (request.method === "POST" && skillVersionActionMatch) {
    const skillVersionRecordId = Number(skillVersionActionMatch[1]);
    const action = skillVersionActionMatch[2];
    try {
      const origin = { channel: "dashboard" as const };
      const result = action === "evaluate"
        ? commands.evaluateSkillVersion(origin, skillVersionRecordId)
        : action === "approve"
          ? commands.approveSkillVersion(origin, skillVersionRecordId)
          : action === "activate"
            ? commands.activateSkillVersion(origin, skillVersionRecordId)
            : action === "rollback"
              ? commands.rollbackSkillVersion(origin, skillVersionRecordId)
              : action === "restore"
                ? commands.restoreSkillVersion(origin, skillVersionRecordId)
                : commands.archiveSkillVersion(origin, skillVersionRecordId);
      sendJson(response, 200, { result });
    } catch (error) {
      sendCommandError(response, error, `skill_version_${action}_failed`);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/feature-plans/queue") {
    const projectKey = url.searchParams.get("projectKey");
    try {
      sendJson(response, 200, { featurePlanQueue: commands.listFeaturePlanQueue(projectKey) });
    } catch (error) {
      sendCommandError(response, error, "feature_plan_queue_failed");
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/feature-plans") {
    const projectKey = url.searchParams.get("projectKey");
    try {
      sendJson(response, 200, { featurePlans: commands.listFeaturePlans(projectKey) });
    } catch (error) {
      sendCommandError(response, error, "feature_plan_list_failed");
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/feature-plans") {
    const body = await readJsonBody(request);
    try {
      const result = commands.createFeaturePlan({ channel: "dashboard" }, {
        projectKey: readString(body.projectKey),
        objective: readString(body.objective),
        acceptanceCriteria: readStringArray(body.acceptanceCriteria),
        taskIds: readNumberArray(body.taskIds),
        taskContracts: readFeatureTaskContracts(body.taskContracts),
        priority: typeof body.priority === "number" ? body.priority : undefined,
        dependsOnFeaturePlanIds: Array.isArray(body.dependsOnFeaturePlanIds) ? readNumberArray(body.dependsOnFeaturePlanIds) : undefined,
        featureIssueNumber: readOptionalPositiveInteger(body.featureIssueNumber),
        taskIssueNumbers: readTaskIssueNumbers(body.taskIssueNumbers),
        idempotencyKey: readString(body.idempotencyKey) || null
      });
      sendJson(response, result.applied ? 201 : 200, result);
    } catch (error) {
      sendCommandError(response, error, "feature_plan_create_failed");
    }
    return;
  }

  const pauseFeaturePlanMatch = url.pathname.match(/^\/api\/feature-plans\/(\d+)\/pause$/);
  if (request.method === "POST" && pauseFeaturePlanMatch) {
    const body = await readJsonBody(request);
    try {
      const result = commands.pauseFeaturePlan(
        { channel: "dashboard" },
        Number(pauseFeaturePlanMatch[1]),
        readString(body.reason) || null
      );
      sendJson(response, 200, result);
    } catch (error) {
      sendCommandError(response, error, "feature_plan_pause_failed");
    }
    return;
  }

  const resumeFeaturePlanMatch = url.pathname.match(/^\/api\/feature-plans\/(\d+)\/resume$/);
  if (request.method === "POST" && resumeFeaturePlanMatch) {
    try {
      const result = commands.resumeFeaturePlan(
        { channel: "dashboard" },
        Number(resumeFeaturePlanMatch[1])
      );
      sendJson(response, 200, result);
    } catch (error) {
      sendCommandError(response, error, "feature_plan_resume_failed");
    }
    return;
  }

  const priorityFeaturePlanMatch = url.pathname.match(/^\/api\/feature-plans\/(\d+)\/priority$/);
  if (request.method === "POST" && priorityFeaturePlanMatch) {
    const body = await readJsonBody(request);
    try {
      const priority = typeof body.priority === "number" ? body.priority : Number(body.priority);
      const result = commands.updateFeaturePlanPriority(
        { channel: "dashboard" },
        Number(priorityFeaturePlanMatch[1]),
        priority
      );
      sendJson(response, 200, result);
    } catch (error) {
      sendCommandError(response, error, "feature_plan_priority_failed");
    }
    return;
  }

  const addDependencyMatch = url.pathname.match(/^\/api\/feature-plans\/(\d+)\/dependencies$/);
  if (request.method === "POST" && addDependencyMatch) {
    const body = await readJsonBody(request);
    try {
      const dependsOnFeaturePlanId = typeof body.dependsOnFeaturePlanId === "number"
        ? body.dependsOnFeaturePlanId
        : Number(body.dependsOnFeaturePlanId);
      const result = commands.addFeaturePlanDependency(
        { channel: "dashboard" },
        Number(addDependencyMatch[1]),
        dependsOnFeaturePlanId
      );
      sendJson(response, 200, result);
    } catch (error) {
      sendCommandError(response, error, "feature_plan_dependency_add_failed");
    }
    return;
  }

  const removeDependencyMatch = url.pathname.match(/^\/api\/feature-plans\/(\d+)\/dependencies\/(\d+)$/);
  if (request.method === "DELETE" && removeDependencyMatch) {
    try {
      const result = commands.removeFeaturePlanDependency(
        { channel: "dashboard" },
        Number(removeDependencyMatch[1]),
        Number(removeDependencyMatch[2])
      );
      sendJson(response, 200, result);
    } catch (error) {
      sendCommandError(response, error, "feature_plan_dependency_remove_failed");
    }
    return;
  }

  const statusFeaturePlanMatch = url.pathname.match(/^\/api\/feature-plans\/(\d+)\/status$/);
  if (request.method === "POST" && statusFeaturePlanMatch) {
    const body = await readJsonBody(request);
    try {
      const result = commands.updateFeaturePlanQueueStatus(
        { channel: "dashboard" },
        Number(statusFeaturePlanMatch[1]),
        readString(body.status) as import("../db.js").FeaturePlanQueueStatus,
        readString(body.reason) || null
      );
      sendJson(response, 200, result);
    } catch (error) {
      sendCommandError(response, error, "feature_plan_status_failed");
    }
    return;
  }

  const eligibilityFeaturePlanMatch = url.pathname.match(/^\/api\/feature-plans\/(\d+)\/eligibility$/);
  if (request.method === "GET" && eligibilityFeaturePlanMatch) {
    try {
      const eligibility = commands.getFeaturePlanEligibility(Number(eligibilityFeaturePlanMatch[1]));
      sendJson(response, 200, { eligibility });
    } catch (error) {
      sendCommandError(response, error, "feature_plan_eligibility_failed");
    }
    return;
  }

  const historyFeaturePlanMatch = url.pathname.match(/^\/api\/feature-plans\/(\d+)\/history$/);
  if (request.method === "GET" && historyFeaturePlanMatch) {
    try {
      const history = commands.getFeaturePlanHistory(Number(historyFeaturePlanMatch[1]));
      sendJson(response, 200, { history });
    } catch (error) {
      sendCommandError(response, error, "feature_plan_history_failed");
    }
    return;
  }

  const featurePlanMatch = url.pathname.match(/^\/api\/feature-plans\/(\d+)$/);
  if (request.method === "GET" && featurePlanMatch) {
    try {
      sendJson(response, 200, commands.getFeaturePlan(Number(featurePlanMatch[1])));
    } catch (error) {
      sendCommandError(response, error, "feature_plan_get_failed");
    }
    return;
  }

  const cancelFeaturePlanMatch = url.pathname.match(/^\/api\/feature-plans\/(\d+)\/cancel$/);
  if (request.method === "POST" && cancelFeaturePlanMatch) {
    const body = await readJsonBody(request);
    try {
      const result = commands.cancelFeaturePlan(
        { channel: "dashboard" },
        Number(cancelFeaturePlanMatch[1]),
        readString(body.reason) || null
      );
      sendJson(response, 200, result);
    } catch (error) {
      sendCommandError(response, error, "feature_plan_cancel_failed");
    }
    return;
  }

  const retryFeaturePlanMatch = url.pathname.match(/^\/api\/feature-plans\/(\d+)\/retry$/);
  if (request.method === "POST" && retryFeaturePlanMatch) {
    const body = await readJsonBody(request);
    try {
      const result = commands.retryFeaturePlan(
        { channel: "dashboard" },
        Number(retryFeaturePlanMatch[1]),
        readString(body.reason) || null
      );
      sendJson(response, 200, result);
    } catch (error) {
      sendCommandError(response, error, "feature_plan_retry_failed");
    }
    return;
  }

  const replanFeaturePlanMatch = url.pathname.match(/^\/api\/feature-plans\/(\d+)\/replan$/);
  if (request.method === "POST" && replanFeaturePlanMatch) {
    const body = await readJsonBody(request);
    try {
      const result = commands.replanFeaturePlan(
        { channel: "dashboard" },
        Number(replanFeaturePlanMatch[1]),
        {
          objective: readString(body.objective),
          acceptanceCriteria: readStringArray(body.acceptanceCriteria),
          taskIds: readNumberArray(body.taskIds),
          taskContracts: readFeatureTaskContracts(body.taskContracts),
          idempotencyKey: readString(body.idempotencyKey) || null
        }
      );
      sendJson(response, 200, result);
    } catch (error) {
      sendCommandError(response, error, "feature_plan_replan_failed");
    }
    return;
  }

  const integrateFeaturePlanMatch = url.pathname.match(/^\/api\/feature-plans\/(\d+)\/integrate$/);
  if (request.method === "POST" && integrateFeaturePlanMatch) {
    try {
      const result = await commands.integrateFeaturePlan(
        { channel: "dashboard" },
        Number(integrateFeaturePlanMatch[1]),
        options.config.worktreesPath
      );
      sendJson(response, 200, result);
    } catch (error) {
      sendCommandError(response, error, "feature_plan_integration_failed");
    }
    return;
  }

  const cancelFeatureMatch = url.pathname.match(/^\/api\/features\/(\d+)\/cancel$/);
  if (request.method === "POST" && cancelFeatureMatch) {
    const body = await readJsonBody(request);
    try {
      const feature = await commands.cancelFeature(
        { channel: "dashboard" },
        Number(cancelFeatureMatch[1]),
        readString(body.reason) || null
      );
      sendJson(response, 200, { feature });
    } catch (error) {
      sendCommandError(response, error, "feature_cancel_failed");
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/work-intake/preview") {
    const body = await readJsonBody(request);
    const objective = typeof body.objective === "string" ? body.objective.trim() : "";
    if (!objective) {
      sendJson(response, 400, { error: "objective_is_required" });
      return;
    }
    try {
      const result = commands.previewWorkIntake({ channel: "dashboard" }, {
        projectKey: typeof body.projectKey === "string" ? body.projectKey.trim() : undefined,
        objective,
        acceptanceCriteria: Array.isArray(body.acceptanceCriteria) ? body.acceptanceCriteria : undefined,
        coordination: body.coordination as WorkIntakeCommandInput["coordination"],
        costEstimate: body.costEstimate as WorkIntakeCommandInput["costEstimate"],
        explicitOverride: body.explicitOverride as WorkIntakeCommandInput["explicitOverride"]
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendCommandError(response, error, "work_intake_preview_failed");
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/work-intake") {
    const body = await readJsonBody(request);
    const objective = typeof body.objective === "string" ? body.objective.trim() : "";
    if (!objective) {
      sendJson(response, 400, { error: "objective_is_required" });
      return;
    }
    try {
      const result = commands.submitWorkIntake({ channel: "dashboard" }, {
        projectKey: typeof body.projectKey === "string" ? body.projectKey.trim() : undefined,
        objective,
        acceptanceCriteria: Array.isArray(body.acceptanceCriteria) ? body.acceptanceCriteria : undefined,
        coordination: body.coordination as WorkIntakeCommandInput["coordination"],
        costEstimate: body.costEstimate as WorkIntakeCommandInput["costEstimate"],
        explicitOverride: body.explicitOverride as WorkIntakeCommandInput["explicitOverride"],
        intakeId: typeof body.intakeId === "string" ? body.intakeId.trim() : undefined
      });
      const statusCode = result.status === "created" ? 201 : 200;
      sendJson(response, statusCode, result);
    } catch (error) {
      sendCommandError(response, error, "work_intake_submit_failed");
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tasks") {
    const body = await readJsonBody(request);
    const projectKey = typeof body.projectKey === "string" ? body.projectKey.trim().toLowerCase() : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";

    if (!projectKey || !text) {
      sendJson(response, 400, { error: "projectKey_and_text_are_required" });
      return;
    }

    try {
      const task = commands.createTask({ channel: "dashboard" }, { text, projectKey });
      sendJson(response, 201, { task });
    } catch (error) {
      sendCommandError(response, error, "task_create_failed");
    }
    return;
  }

  const cancelTaskMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/cancel$/);
  if (request.method === "POST" && cancelTaskMatch) {
    if (!options.goalCoordinator) {
      sendJson(response, 503, { error: "goal_runner_unavailable" });
      return;
    }
    try {
      const task = options.goalCoordinator.cancel(Number(cancelTaskMatch[1]));
      sendJson(response, 200, { task });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown cancellation error";
      sendJson(response, /not found/i.test(message) ? 404 : 409, {
        error: "task_cancel_failed",
        details: message
      });
    }
    return;
  }

  const retryTaskMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/retry$/);
  if (request.method === "POST" && retryTaskMatch) {
    if (!options.goalCoordinator) {
      sendJson(response, 503, { error: "goal_runner_unavailable" });
      return;
    }
    try {
      const goal = options.goalCoordinator.retryTask(Number(retryTaskMatch[1]));
      sendJson(response, 200, { goal });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown retry error";
      sendJson(response, /not found/i.test(message) ? 404 : 409, {
        error: "task_retry_failed",
        details: message
      });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/chat/messages") {
    const projectKey = url.searchParams.get("projectKey")?.trim().toLowerCase() || "";
    const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 50;

    if (!projectKey) {
      sendJson(response, 400, { error: "projectKey_is_required" });
      return;
    }

    try {
      const messages = await chatService.getHistory(projectKey, limit);
      sendJson(response, 200, { projectKey, messages });
    } catch (error) {
      sendJson(response, 500, { error: "chat_history_failed", details: error instanceof Error ? error.message : "unknown" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/chat/ask") {
    const body = await readJsonBody(request);
    const projectKey = typeof body.projectKey === "string" ? body.projectKey.trim().toLowerCase() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";

    if (!projectKey || !message) {
      sendJson(response, 400, { error: "projectKey_and_message_are_required" });
      return;
    }

    try {
      const chatResponse = await chatService.ask({
        projectKey,
        surface: "dashboard",
        message
      });
      sendJson(response, 200, chatResponse);
    } catch (error) {
      sendJson(response, 500, { error: "chat_ask_failed", details: error instanceof Error ? error.message : "unknown" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/chat/action") {
    const body = await readJsonBody(request);
    const projectKey = typeof body.projectKey === "string" ? body.projectKey.trim().toLowerCase() : "";
    const action = body.action as import("../chat/types.js").GovernedChatAction;

    if (!projectKey || !action || !(action as any).type || (action as any).targetId === undefined) {
      sendJson(response, 400, { error: "projectKey_and_valid_action_are_required" });
      return;
    }

    try {
      const actionResult = await chatService.executeAction({
        projectKey,
        surface: "dashboard",
        action
      });
      sendJson(response, 200, actionResult);
    } catch (error) {
      sendJson(response, 500, { error: "chat_action_failed", details: error instanceof Error ? error.message : "unknown" });
    }
    return;
  }

  const deleteTaskMatch = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (request.method === "DELETE" && deleteTaskMatch) {
    const taskId = Number(deleteTaskMatch[1]);
    if (options.goalCoordinator?.isActive(taskId)) {
      sendJson(response, 409, { error: "task_delete_failed", details: "Cancel the active task before deleting it." });
      return;
    }
    try {
      const task = options.database.deleteTask(taskId);
      options.database.addEvent({
        source: "dashboard",
        type: "task.deleted",
        text: `Task #${task.id} deleted.`,
        metadata: { deletedTaskId: task.id, projectKey: task.projectKey }
      });
      sendJson(response, 200, { task });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown deletion error";
      sendJson(response, /not found/i.test(message) ? 404 : 409, {
        error: "task_delete_failed",
        details: message
      });
    }
    return;
  }

  const prepareMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/prepare$/);
  if (request.method === "POST" && prepareMatch) {
    const taskId = Number(prepareMatch[1]);
    try {
      const result = commands.prepareTask({ channel: "dashboard" }, taskId, options.config.worktreesPath);
      sendJson(response, 200, { task: result.task });
    } catch (error) {
      sendCommandError(response, error, "task_prepare_failed");
    }
    return;
  }

  const reviewsMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/reviews$/);
  if (request.method === "GET" && reviewsMatch) {
    const taskId = Number(reviewsMatch[1]);
    try {
      options.database.getTask(taskId);
    } catch {
      sendJson(response, 404, { error: "task_not_found" });
      return;
    }
    sendJson(response, 200, { reviews: options.database.listTaskReviews(taskId) });
    return;
  }

  const goalStartMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/goal$/);
  if (request.method === "POST" && goalStartMatch) {
    if (!options.goalCoordinator) {
      sendJson(response, 503, { error: "goal_runner_unavailable" });
      return;
    }
    const taskId = Number(goalStartMatch[1]);
    const body = await readJsonBody(request);
    const requestedMaxSteps = typeof body.maxSteps === "number" ? body.maxSteps : 12;
    const maxSteps = Math.min(30, Math.max(4, Math.trunc(requestedMaxSteps)));
    try {
      const run = options.goalCoordinator.start(taskId, maxSteps);
      sendJson(response, 202, { run });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown goal start error";
      const status = message.includes("not found") ? 404 : 409;
      sendJson(response, status, { error: "goal_start_failed", details: message });
    }
    return;
  }

  const goalMatch = url.pathname.match(/^\/api\/goals\/(\d+)$/);
  if (request.method === "GET" && goalMatch) {
    const runId = Number(goalMatch[1]);
    try {
      const run = options.database.getGoalRun(runId);
      sendJson(response, 200, {
        run: {
          ...run,
          lastError: run.lastError ? redactSensitiveText(run.lastError) : null
        },
        steps: options.database.listGoalSteps(run.id).map((step) => ({
          ...step,
          summary: redactSensitiveText(step.summary),
          output: redactSensitiveText(step.output),
          error: step.error ? redactSensitiveText(step.error) : null
        })),
        skills: options.database.listGoalSkillPins(run.id).map((pin) => ({
          ...pin,
          triggerReason: redactSensitiveText(pin.triggerReason),
          usage: options.database.listSkillUsage(run.id).filter(
            (item) => item.skillVersionRecordId === pin.skillVersionRecordId
          )
        }))
      });
    } catch {
      sendJson(response, 404, { error: "goal_run_not_found" });
    }
    return;
  }

  const claudeReviewMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/reviews\/claude$/);
  if (request.method === "POST" && claudeReviewMatch) {
    const taskId = Number(claudeReviewMatch[1]);
    let task;
    try {
      task = options.database.getTask(taskId);
    } catch {
      sendJson(response, 404, { error: "task_not_found" });
      return;
    }

    if (!task.projectKey || !task.worktreePath) {
      sendJson(response, 409, { error: "task_worktree_required" });
      return;
    }

    const project = options.database.getProjectByKey(task.projectKey);
    const reviewer = options.claudeReviewer ?? reviewTaskWithClaude;
    const result = await reviewer(task, project);
    const review = options.database.addTaskReview({
      taskId,
      provider: "claude",
      status: result.status,
      content: result.content,
      error: result.error
    });

    options.database.addEvent({
      source: "claude",
      type: result.status === "completed" ? "task.reviewed" : "task.review_failed",
      text: result.status === "completed" ? `Claude review #${review.id}` : result.error ?? "Claude review failed",
      taskId,
      metadata: { reviewId: review.id, status: result.status, durationMs: result.durationMs }
    });

    const statusCode = result.status === "completed" ? 201 : result.status === "auth_required" ? 503 : 500;
    sendJson(response, statusCode, { review });
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  serveStatic(response, staticRoot, url.pathname);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) {
      throw new Error("Request body exceeds 64 KB.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readEnum(value: unknown, options: readonly string[]): string | null {
  return typeof value === "string" && options.includes(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
}

function readOptionalPositiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function readTaskIssueNumbers(value: unknown): Record<number, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<number, number> = {};
  for (const [taskId, issueNumber] of Object.entries(value)) {
    const normalizedTaskId = Number(taskId);
    if (!Number.isInteger(normalizedTaskId) || normalizedTaskId <= 0) continue;
    if (!Number.isInteger(issueNumber) || Number(issueNumber) <= 0) continue;
    result[normalizedTaskId] = Number(issueNumber);
  }
  return result;
}

function readFeatureTaskContracts(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      taskId: Number(item.taskId),
      objective: readString(item.objective) || undefined,
      acceptanceCriteria: readStringArray(item.acceptanceCriteria),
      excludedScope: readStringArray(item.excludedScope),
      mutationScope: readStringArray(item.mutationScope),
      dependsOnTaskIds: readNumberArray(item.dependsOnTaskIds),
      parallelMode: (readEnum(item.parallelMode, ["serial", "parallel"]) as "serial" | "parallel" | null)
        ?? undefined
    }));
}

function serveStatic(response: ServerResponse, staticRoot: string, pathname: string) {
  if (!fs.existsSync(staticRoot)) {
    sendJson(response, 404, { error: "ui_not_built", hint: "Run npm run build:ui." });
    return;
  }

  const requestedPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolvedPath = path.resolve(staticRoot, requestedPath);
  const safeRoot = `${path.resolve(staticRoot)}${path.sep}`;
  const candidate = resolvedPath.startsWith(safeRoot) ? resolvedPath : path.join(staticRoot, "index.html");
  const filePath = fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : path.join(staticRoot, "index.html");

  if (!fs.existsSync(filePath)) {
    sendJson(response, 404, { error: "ui_entry_missing" });
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable"
  });
  fs.createReadStream(filePath).pipe(response);
}

function sendCommandError(response: ServerResponse, error: unknown, errorCode: string) {
  if (error instanceof ApplicationCommandError) {
    const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
    sendJson(response, status, { error: errorCode, details: error.details });
    return;
  }
  sendJson(response, 500, {
    error: errorCode,
    details: [error instanceof Error ? error.message : "Unknown error"]
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  response.end(JSON.stringify(payload));
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml"
  }[extension] ?? "application/octet-stream";
}
