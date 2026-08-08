import fs from "node:fs";
import path from "node:path";
import {
  FeaturePlanIntegrationDetails,
  FeaturePlanDetails,
  FeaturePlanWriteResult,
  FeatureRecord,
  ImprovementProposalRecord,
  ImprovementStatus,
  MaestroDatabase,
  ProjectRecord,
  SkillEvaluationRecord,
  SkillProposalRecord,
  SkillProposalStatus,
  SkillVersionRecord,
  TaskRecord
} from "../db.js";
import { FeatureGitHubGateway, GhFeatureGateway } from "../features/github.js";
import { FeatureIntegrationBuilder, WorkPullRequestGateway } from "../features/integration.js";
import { createGitWorktree, createWorktreePlan, validateGitProject } from "../git.js";
import { redactSensitiveText, sanitizePublicMetadata, truncateForDisplay } from "../security/redaction.js";
import { conflictError, notFoundError, validationError } from "./errors.js";
import { CommandOrigin } from "./types.js";
import type { WorkGraphDetails } from "../work-graphs/types.js";
import type { FeatureTaskContractInput } from "../features/task-graph.js";
import { prepareFeatureTaskBaseline } from "../features/task-baseline.js";
import { revalidateQueuedFeaturePlans } from "../features/task-scheduler.js";
import { SkillLifecycleService, suggestSkillProposalQualifiedName, type SkillLifecycleRuntime } from "../skills/lifecycle.js";
import type { SkillCuratorReport } from "../skills/curator.js";
import type { FeatureCoordinator, ManualReviewResult, ManualReviewStatusResult } from "../features/coordinator.js";

export type RegisterProjectInput = {
  key: string;
  path: string;
  name?: string;
  defaultBranch?: string;
};

export type RegisterProjectOutcome = {
  project: ProjectRecord;
  warnings: string[];
};

export type CreateTaskInput = {
  text: string;
  projectKey?: string | null;
};

export type CreateFeaturePlanInput = {
  projectKey: string;
  objective: string;
  acceptanceCriteria: string[];
  taskIds: number[];
  taskContracts?: FeatureTaskContractInput[];
  priority?: number;
  dependsOnFeaturePlanIds?: number[];
  featureIssueNumber?: number | null;
  taskIssueNumbers?: Record<number, number>;
  idempotencyKey?: string | null;
};

export type ReplanFeaturePlanInput = {
  objective: string;
  acceptanceCriteria: string[];
  taskIds: number[];
  taskContracts?: FeatureTaskContractInput[];
  idempotencyKey?: string | null;
};

export type PrepareTaskOutcome = {
  task: TaskRecord;
  branchName: string;
  worktreePath: string;
};

export type ImprovementDecisionOutcome = {
  improvement: ImprovementProposalRecord;
  task: TaskRecord | null;
  featurePlan: FeaturePlanDetails | null;
};

export type WorkGraphRuntimeCommands = {
  cancel(origin: CommandOrigin, workGraphId: number, reason?: string | null): Promise<WorkGraphDetails>;
};

export type WorkGraphAttemptView = {
  attemptNumber: number;
  provider: string;
  status: string;
  durationMs: number | null;
  summary: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type WorkGraphNodeView = WorkGraphDetails["nodes"][number] & {
  objective: string;
  writeScope: string[];
  lastError: string | null;
  attempts: WorkGraphAttemptView[];
  fallbackCount: number;
};

export type WorkGraphAdoptionView = {
  mode: string;
  decision: string;
  reason: string;
  executionMode: string;
  automaticFanOut: boolean;
  telemetry: unknown;
};

export type WorkGraphArtifactView = {
  nodeId: number;
  key: string;
  kind: string;
  summary: string;
  contentHash: string | null;
  bytes: number;
};

export type WorkGraphCanaryEvidence = {
  durationMs: number;
  estimatedTokens: number;
  attempts: number;
  fallbacks: number;
  conflicts: number;
  quality: "passed" | "degraded" | "blocked" | "cancelled" | "pending";
};

export type WorkGraphView = Omit<WorkGraphDetails, "nodes" | "objective"> & {
  taskId: number;
  projectKey: string | null;
  objective: string;
  adoption: WorkGraphAdoptionView | null;
  nodes: WorkGraphNodeView[];
  artifacts: WorkGraphArtifactView[];
  artifactCount: number;
  artifactBytes: number;
  canary: WorkGraphCanaryEvidence;
  cancellable: boolean;
};

const WORK_GRAPH_DISPLAY_LIMIT = 500;

function publicText(value: string): string {
  const redacted = redactSensitiveText(value)
    .replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, "[REDACTED_LOCAL_PATH]")
    .replace(
      /(^|[\s"'(])\/(?:tmp|var|opt|srv|mnt|home|Users)\/[^\s"',)]+/g,
      "$1[REDACTED_LOCAL_PATH]"
    );
  return truncateForDisplay(redacted, WORK_GRAPH_DISPLAY_LIMIT);
}

function publicScope(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return path.isAbsolute(value) || normalized.split("/").includes("..")
    ? "[REDACTED_LOCAL_PATH]"
    : publicText(normalized);
}

function publicArtifactKey(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return path.isAbsolute(value) || normalized.split("/").includes("..")
    ? "[REDACTED_ARTIFACT_KEY]"
    : publicText(normalized);
}

function adoptionView(metadata: Record<string, unknown>): WorkGraphAdoptionView {
  return {
    mode: String(metadata.mode ?? "unknown"),
    decision: String(metadata.decision ?? "unknown"),
    reason: publicText(String(metadata.reason ?? "unknown")),
    executionMode: String(metadata.executionMode ?? "unknown"),
    automaticFanOut: metadata.automaticFanOut === true,
    telemetry: sanitizePublicMetadata(metadata.telemetry ?? {})
  };
}

export class ApplicationCommands {
  private readonly skillLifecycleService?: SkillLifecycleService;

  constructor(
    private readonly database: MaestroDatabase,
    private readonly featureGithub: FeatureGitHubGateway = new GhFeatureGateway(),
    private readonly workGraphRuntime?: WorkGraphRuntimeCommands,
    skillLifecycle?: SkillLifecycleRuntime,
    private readonly featureCoordinator?: FeatureCoordinator
  ) {
    this.skillLifecycleService = skillLifecycle
      ? new SkillLifecycleService(database, skillLifecycle)
      : undefined;
  }

  async triggerFeatureReview(
    origin: CommandOrigin,
    targetInput: string,
    isRetry = false
  ): Promise<ManualReviewResult> {
    const feature = this.database.findFeatureByTarget(targetInput);
    if (!feature) {
      throw notFoundError("Feature PR nao encontrado para o alvo especificado.");
    }
    if (!this.featureCoordinator) {
      throw validationError("Feature Coordinator indisponivel.");
    }
    return this.featureCoordinator.triggerManualReview(feature.id, isRetry);
  }

  async getFeatureReviewStatus(
    origin: CommandOrigin,
    targetInput: string
  ): Promise<ManualReviewStatusResult> {
    const feature = this.database.findFeatureByTarget(targetInput);
    if (!feature) {
      throw notFoundError("Feature PR nao encontrado para o alvo especificado.");
    }
    if (!this.featureCoordinator) {
      throw validationError("Feature Coordinator indisponivel.");
    }
    return this.featureCoordinator.getReviewStatus(feature.id);
  }

  registerProject(origin: CommandOrigin, input: RegisterProjectInput): RegisterProjectOutcome {
    const warnings: string[] = [];
    const projectPath = path.resolve(input.path.trim());

    if (!fs.existsSync(projectPath)) {
      throw validationError(`Path does not exist: ${projectPath}`);
    }
    if (!fs.statSync(projectPath).isDirectory()) {
      throw validationError(`Path is not a directory: ${projectPath}`);
    }
    if (!fs.existsSync(path.join(projectPath, ".git"))) {
      warnings.push("Path exists, but .git was not found. Future Git automation will be blocked.");
    }

    let project: ProjectRecord;
    try {
      project = this.database.registerProject({
        key: input.key,
        name: input.name,
        path: projectPath,
        defaultBranch: input.defaultBranch
      });
    } catch (error) {
      throw validationError(error instanceof Error ? error.message : "Unknown project error.");
    }

    this.database.addEvent({
      source: origin.channel,
      type: "project.registered",
      text: project.key,
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      metadata: { projectKey: project.key, defaultBranch: project.defaultBranch, warnings }
    });

    return { project, warnings };
  }

  createTask(origin: CommandOrigin, input: CreateTaskInput): TaskRecord {
    const text = input.text.trim();
    if (!text) {
      throw validationError("Task text is required.");
    }

    const projectKey = input.projectKey?.trim().toLowerCase() || null;
    const project = projectKey ? this.database.findProjectByKey(projectKey) : this.database.getDefaultProject();

    if (projectKey && !project) {
      throw notFoundError(`Project not found: ${projectKey}`);
    }
    if (!project) {
      throw notFoundError("No project registered.");
    }

    const task = this.database.createTask(text, origin.channel, project.key);

    this.database.addEvent({
      source: origin.channel,
      type: "task.created",
      text,
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      taskId: task.id,
      metadata: { projectKey: project.key }
    });

    return task;
  }

  listWorkGraphs(limit = 30): WorkGraphView[] {
    const events = this.database.listEvents(200);
    return this.database.listWorkGraphs(limit).map((graph) => this.toWorkGraphView(graph, events));
  }

  getWorkGraph(workGraphId: number): WorkGraphView {
    try {
      return this.toWorkGraphView(this.database.getWorkGraphDetails(workGraphId));
    } catch (error) {
      throw notFoundError(error instanceof Error ? error.message : `Work Graph #${workGraphId} not found.`);
    }
  }

  async cancelWorkGraph(origin: CommandOrigin, workGraphId: number, reason?: string | null): Promise<WorkGraphView> {
    const graph = this.getRawWorkGraph(workGraphId);
    if (["completed", "blocked", "cancelled"].includes(graph.status)) {
      throw conflictError(`Work Graph #${workGraphId} is already ${graph.status}.`);
    }
    if (this.workGraphRuntime) {
      try {
        return this.toWorkGraphView(await this.workGraphRuntime.cancel(origin, workGraphId, reason));
      } catch (error) {
        throw conflictError(error instanceof Error ? error.message : "Work Graph cancellation failed.");
      }
    }
    if (graph.status === "running") {
      throw conflictError(
        `Work Graph #${workGraphId} is running and requires its runtime coordinator to abort safely.`
      );
    }
    const cancellationReason = reason?.trim() || "Cancelled by operator.";
    for (const node of graph.nodes) {
      if (!["completed", "blocked", "cancelled"].includes(node.status)) {
        this.database.updateWorkerNodeStatus(node.id, "cancelled", cancellationReason);
      }
    }
    this.database.updateWorkGraphStatus(graph.id, "cancelled");
    this.database.addEvent({
      source: origin.channel,
      type: "work_graph.cancelled",
      text: graph.objective,
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      metadata: { graphId: graph.id, runId: graph.runId, reason: redactSensitiveText(cancellationReason) }
    });
    return this.toWorkGraphView(this.database.getWorkGraphDetails(graph.id));
  }

  private getRawWorkGraph(workGraphId: number): WorkGraphDetails {
    try {
      return this.database.getWorkGraphDetails(workGraphId);
    } catch (error) {
      throw notFoundError(error instanceof Error ? error.message : `Work Graph #${workGraphId} not found.`);
    }
  }

  private toWorkGraphView(
    graph: WorkGraphDetails,
    events = this.database.listEvents(200)
  ): WorkGraphView {
    const run = this.database.getGoalRun(graph.runId);
    const task = this.database.getTask(run.taskId);
    const artifacts = this.database.listWorkerArtifacts(graph.id).map((artifact): WorkGraphArtifactView => ({
      nodeId: artifact.nodeId,
      key: publicArtifactKey(artifact.key),
      kind: artifact.kind,
      summary: publicText(artifact.summary),
      contentHash: artifact.contentHash,
      bytes: artifact.bytes
    }));
    let fallbackCount = 0;
    let conflictCount = 0;
    let attemptCount = 0;
    let durationMs = 0;
    let degraded = false;
    const nodes = graph.nodes.map((node): WorkGraphNodeView => {
      const attempts = this.database.listWorkerAttempts(node.id).map((attempt): WorkGraphAttemptView => {
        attemptCount += 1;
        durationMs += attempt.durationMs ?? 0;
        if (!["completed", "running"].includes(attempt.status)) degraded = true;
        if (attempt.error && /(?:outside|beyond).*scope|scope violation|write conflict|mutation scope/i.test(attempt.error)) {
          conflictCount += 1;
        }
        return {
          attemptNumber: attempt.attemptNumber,
          provider: attempt.provider,
          status: attempt.status,
          durationMs: attempt.durationMs,
          summary: publicText(attempt.summary),
          error: attempt.error ? publicText(attempt.error) : null,
          createdAt: attempt.createdAt,
          finishedAt: attempt.finishedAt
        };
      });
      const nodeFallbacks = attempts.reduce((count, attempt, index) => (
        index > 0 && attempt.provider !== attempts[index - 1]!.provider ? count + 1 : count
      ), 0);
      fallbackCount += nodeFallbacks;
      return {
        ...node,
        key: publicText(node.key),
        objective: publicText(node.objective),
        dependsOn: node.dependsOn.map(publicText),
        inputArtifacts: node.inputArtifacts.map(publicArtifactKey),
        outputContract: publicText(node.outputContract),
        skillVersions: node.skillVersions.map(publicText),
        writeScope: node.writeScope.map(publicScope),
        lastError: node.lastError ? publicText(node.lastError) : null,
        attempts,
        fallbackCount: nodeFallbacks
      };
    });
    const adoptionEvent = events.find((event) => (
      event.type === "goal.work_graph_adoption_decision" && Number(event.metadata.runId) === graph.runId
    ));
    const adoption = adoptionEvent ? adoptionView(adoptionEvent.metadata) : null;
    const artifactBytes = artifacts.reduce((total, artifact) => total + artifact.bytes, 0);
    const quality: WorkGraphCanaryEvidence["quality"] = graph.status === "completed"
      ? degraded || fallbackCount > 0 ? "degraded" : "passed"
      : graph.status === "blocked"
        ? "blocked"
        : graph.status === "cancelled"
          ? "cancelled"
          : "pending";
    return {
      ...graph,
      taskId: task.id,
      projectKey: task.projectKey,
      objective: publicText(graph.objective),
      adoption,
      nodes,
      artifacts,
      artifactCount: artifacts.length,
      artifactBytes,
      canary: {
        durationMs,
        estimatedTokens: Math.ceil(artifactBytes / 4),
        attempts: attemptCount,
        fallbacks: fallbackCount,
        conflicts: conflictCount,
        quality
      },
      cancellable: !["completed", "blocked", "cancelled"].includes(graph.status)
    };
  }

  createFeaturePlan(origin: CommandOrigin, input: CreateFeaturePlanInput): FeaturePlanWriteResult {
    try {
      const result = this.database.createFeaturePlan({
        projectKey: input.projectKey,
        objective: input.objective,
        acceptanceCriteria: input.acceptanceCriteria,
        taskIds: input.taskIds,
        taskContracts: input.taskContracts,
        priority: input.priority,
        dependsOnFeaturePlanIds: input.dependsOnFeaturePlanIds,
        featureIssueNumber: input.featureIssueNumber,
        taskIssueNumbers: input.taskIssueNumbers,
        idempotencyKey: input.idempotencyKey,
        source: origin.channel,
        createdByUserId: origin.userId ?? null,
        createdByUsername: origin.username ?? null
      });

      if (result.applied) {
        this.database.addEvent({
          source: origin.channel,
          type: "feature_plan.created",
          text: result.plan.objective,
          userId: origin.userId ?? null,
          username: origin.username ?? null,
          metadata: {
            featurePlanId: result.plan.id,
            projectKey: result.plan.projectKey,
            taskIds: result.tasks.map((task) => task.taskId),
            githubIssues: this.database.getFeaturePlanIssueLinks(result.plan.id),
            acceptanceCriteriaCount: result.plan.acceptanceCriteria.length,
            revision: result.plan.revision
          }
        });
      }

      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  decideImprovementProposal(
    origin: CommandOrigin,
    improvementId: number,
    status: Exclude<ImprovementStatus, "candidate">,
    decisionNote?: string | null
  ): ImprovementDecisionOutcome {
    try {
      return this.database.withTransaction(() => {
        const before = this.database.getImprovementProposal(improvementId);
        if (before.status !== "candidate") {
          if (before.status === status && before.taskId && before.featurePlanId) {
            return {
              improvement: before,
              task: this.database.getTask(before.taskId),
              featurePlan: this.database.getFeaturePlanDetails(before.featurePlanId)
            };
          }
          throw new Error(`Improvement proposal ${improvementId} is no longer awaiting a decision.`);
        }

        const decided = this.database.decideImprovementProposal(improvementId, status, decisionNote);
        if (status === "rejected") {
          this.recordImprovementDecision(origin, decided);
          return { improvement: decided, task: null, featurePlan: null };
        }

        const project = decided.projectKey
          ? this.database.findProjectByKey(decided.projectKey)
          : this.database.getDefaultProject();
        if (!project) throw new Error(`Project not found for improvement proposal ${improvementId}.`);
        const isSkillProposal = decided.category === "skill";
        const suggestedQualifiedName = suggestSkillProposalQualifiedName(decided.title);
        const task = this.createTask(origin, {
          projectKey: project.key,
          text: [
            `Implement approved improvement #${decided.id}: ${decided.title}`,
            decided.proposedChange,
            `Targets: ${decided.targets.length > 0 ? decided.targets.join(", ") : "determine during planning"}`,
            "Preserve the Maestro Constitution, human gates, secret handling, audit trail and rollback boundaries.",
            ...(isSkillProposal ? [
              `Create the Skill as an agent-owned draft under skills/repository/, qualified name ${suggestedQualifiedName}.`,
              "Set maestro.yaml owner: agent and include evals/cases.yaml with trigger, content and script checks.",
              "Do not activate, approve or wire the Skill into any runtime path; governed evaluation and promotion happen separately."
            ] : [])
          ].join("\n\n")
        });
        const featurePlan = this.createFeaturePlan(origin, {
          projectKey: project.key,
          objective: `Implement approved improvement #${decided.id}: ${decided.title}`,
          acceptanceCriteria: [
            decided.proposedChange,
            "Run deterministic typecheck, tests, build and secret scan.",
            "Deliver a Draft Work PR and require Final Review only on the consolidated Feature PR.",
            "Do not mutate protected policy, permission, audit or rollback layers automatically.",
            ...(isSkillProposal ? [
              "Ship the Skill as an agent-owned candidate only; never activate, approve or self-promote it."
            ] : [])
          ],
          taskIds: [task.id],
          idempotencyKey: `improvement:${decided.id}:activation`
        });
        const improvement = this.database.attachImprovementActivation(
          decided.id,
          task.id,
          featurePlan.plan.id
        );
        this.recordImprovementDecision(origin, improvement);
        this.database.addEvent({
          source: origin.channel,
          type: "improvement.activated_as_feature_plan",
          text: improvement.title,
          userId: origin.userId ?? null,
          username: origin.username ?? null,
          taskId: task.id,
          metadata: {
            improvementId: improvement.id,
            featurePlanId: featurePlan.plan.id,
            projectKey: project.key
          }
        });
        if (isSkillProposal) {
          const skillProposal = this.database.createSkillProposal({
            improvementProposalId: improvement.id,
            suggestedQualifiedName,
            evidence: improvement.evidence,
            provenance: {
              improvementProposalId: improvement.id,
              source: improvement.source,
              fingerprint: improvement.fingerprint,
              taskId: task.id,
              featurePlanId: featurePlan.plan.id
            }
          });
          this.database.addEvent({
            source: origin.channel,
            type: "skill.proposal_drafted",
            text: skillProposal.suggestedQualifiedName,
            userId: origin.userId ?? null,
            username: origin.username ?? null,
            taskId: task.id,
            metadata: {
              skillProposalId: skillProposal.id,
              improvementId: improvement.id,
              suggestedQualifiedName: skillProposal.suggestedQualifiedName
            }
          });
        }
        return { improvement, task, featurePlan };
      });
    } catch (error) {
      throw validationError(error instanceof Error ? error.message : "Improvement decision failed.");
    }
  }

  listSkillProposals(status?: SkillProposalStatus): SkillProposalRecord[] {
    return this.database.listSkillProposals(status);
  }

  reconcileSkillProposalDrafts(origin: CommandOrigin): SkillProposalRecord[] {
    const linked = this.requireSkillLifecycle().reconcileSkillProposalDrafts();
    for (const proposal of linked) {
      this.database.addEvent({
        source: origin.channel,
        type: "skill.proposal_linked",
        text: proposal.suggestedQualifiedName,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: {
          skillProposalId: proposal.id,
          improvementId: proposal.improvementProposalId,
          qualifiedName: proposal.qualifiedName,
          versionId: proposal.versionId
        }
      });
    }
    return linked;
  }

  evaluateSkillVersion(origin: CommandOrigin, skillVersionRecordId: number): SkillEvaluationRecord {
    try {
      const evaluation = this.requireSkillLifecycle().evaluateVersion(skillVersionRecordId);
      this.database.addEvent({
        source: origin.channel,
        type: "skill.version_evaluated",
        text: evaluation.qualifiedName,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: {
          skillVersionRecordId,
          qualifiedName: evaluation.qualifiedName,
          versionId: evaluation.versionId,
          status: evaluation.status,
          qualityScore: evaluation.qualityScore,
          regressionDetected: evaluation.regressionDetected
        }
      });
      return evaluation;
    } catch (error) {
      throw this.toSkillLifecycleError(error);
    }
  }

  approveSkillVersion(origin: CommandOrigin, skillVersionRecordId: number): SkillVersionRecord {
    return this.runSkillLifecycleTransition(origin, "skill.version_approved", skillVersionRecordId, () => (
      this.requireSkillLifecycle().approveVersion(skillVersionRecordId)
    ));
  }

  activateSkillVersion(origin: CommandOrigin, skillVersionRecordId: number): SkillVersionRecord {
    return this.runSkillLifecycleTransition(origin, "skill.version_activated", skillVersionRecordId, () => (
      this.requireSkillLifecycle().activateVersion(skillVersionRecordId)
    ));
  }

  rollbackSkillVersion(origin: CommandOrigin, skillVersionRecordId: number): SkillVersionRecord {
    return this.runSkillLifecycleTransition(origin, "skill.version_rolled_back", skillVersionRecordId, () => (
      this.requireSkillLifecycle().rollbackVersion(skillVersionRecordId)
    ));
  }

  restoreSkillVersion(origin: CommandOrigin, skillVersionRecordId: number): SkillVersionRecord {
    return this.runSkillLifecycleTransition(origin, "skill.version_restored", skillVersionRecordId, () => (
      this.requireSkillLifecycle().restoreVersion(skillVersionRecordId)
    ));
  }

  archiveSkillVersion(origin: CommandOrigin, skillVersionRecordId: number): SkillVersionRecord {
    return this.runSkillLifecycleTransition(origin, "skill.version_archived", skillVersionRecordId, () => (
      this.requireSkillLifecycle().archiveVersion(skillVersionRecordId, "human")
    ));
  }

  getSkillCuratorReport(): SkillCuratorReport {
    return this.requireSkillLifecycle().curatorDryRun();
  }

  applySkillCuratorAutomaticArchival(origin: CommandOrigin): { archived: string[]; report: SkillCuratorReport } {
    const result = this.requireSkillLifecycle().curatorApplyAutomaticArchival();
    if (result.archived.length > 0) {
      this.database.addEvent({
        source: origin.channel,
        type: "skill.curator_applied",
        text: `${result.archived.length} Skill(s) archived by Curator.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: { archived: result.archived }
      });
    }
    return result;
  }

  private runSkillLifecycleTransition(
    origin: CommandOrigin,
    eventType: string,
    skillVersionRecordId: number,
    transition: () => SkillVersionRecord
  ): SkillVersionRecord {
    try {
      const version = transition();
      this.database.addEvent({
        source: origin.channel,
        type: eventType,
        text: version.qualifiedName,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: {
          skillVersionRecordId: version.id,
          qualifiedName: version.qualifiedName,
          versionId: version.versionId,
          status: version.status
        }
      });
      return version;
    } catch (error) {
      throw this.toSkillLifecycleError(error);
    }
  }

  private requireSkillLifecycle(): SkillLifecycleService {
    if (!this.skillLifecycleService) throw notFoundError("Governed Skill lifecycle is unavailable in this runtime.");
    return this.skillLifecycleService;
  }

  private toSkillLifecycleError(error: unknown): never {
    const message = error instanceof Error ? error.message : "Skill lifecycle operation failed.";
    if (/not found/i.test(message)) throw notFoundError(message);
    throw conflictError(message);
  }

  getFeaturePlan(featurePlanId: number): FeaturePlanDetails {
    try {
      return this.database.getFeaturePlanDetails(featurePlanId);
    } catch (error) {
      throw notFoundError(error instanceof Error ? error.message : `Feature plan not found: ${featurePlanId}`);
    }
  }

  listFeaturePlans(projectKey?: string | null, limit = 30): FeaturePlanDetails[] {
    const plans = projectKey?.trim()
      ? this.database.listFeaturePlansByProject(projectKey.trim().toLowerCase(), limit)
      : this.database.listFeaturePlans(limit);
    return plans.map((plan) => this.database.getFeaturePlanDetails(plan.id));
  }

  async integrateFeaturePlan(
    _origin: CommandOrigin,
    featurePlanId: number,
    worktreesRoot: string,
    github?: WorkPullRequestGateway
  ): Promise<FeaturePlanIntegrationDetails> {
    try {
      return await new FeatureIntegrationBuilder(this.database, worktreesRoot, github).build(featurePlanId);
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  cancelFeaturePlan(origin: CommandOrigin, featurePlanId: number, reason?: string | null): FeaturePlanWriteResult {
    try {
      const result = this.database.cancelFeaturePlan(featurePlanId, reason);
      if (result.applied) {
        this.database.addEvent({
          source: origin.channel,
          type: "feature_plan.cancelled",
          text: result.plan.cancelReason || `Feature Plan #${result.plan.id} cancelled.`,
          userId: origin.userId ?? null,
          username: origin.username ?? null,
          metadata: {
            featurePlanId: result.plan.id,
            projectKey: result.plan.projectKey,
            taskIds: result.tasks.map((task) => task.taskId),
            revision: result.plan.revision
          }
        });
        try {
          revalidateQueuedFeaturePlans(this.database, result.plan.projectKey);
        } catch {
          // best-effort
        }
      }
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  async cancelFeature(origin: CommandOrigin, featureId: number, reason?: string | null): Promise<FeatureRecord> {
    try {
      const before = this.database.getFeature(featureId);
      if (before.status === "cancelled") return before;
      if (["completed", "merging"].includes(before.status)) {
        throw new Error(`Feature #${featureId} cannot be cancelled from status ${before.status}.`);
      }
      const pullRequest = await this.featureGithub.inspect(before.pullRequestUrl);
      if (pullRequest.state === "MERGED") {
        throw new Error(`Feature #${featureId} cannot be cancelled because its pull request is already merged.`);
      }
      const feature = this.database.cancelFeature(featureId, reason);
      if (pullRequest.state === "OPEN") {
        try {
          await this.featureGithub.close(
            before.pullRequestUrl,
            `Feature #${featureId} cancelled before merge. History preserved for audit.`
          );
        } catch (error) {
          this.database.addEvent({
            source: origin.channel,
            type: "feature.cancel_close_failed",
            text: redactSensitiveText(
              error instanceof Error ? error.message : "Unknown GitHub close error."
            ),
            userId: origin.userId ?? null,
            username: origin.username ?? null,
            metadata: { featureId: feature.id, pullRequestUrl: feature.pullRequestUrl }
          });
        }
      }
      this.database.addEvent({
        source: origin.channel,
        type: "feature.cancelled",
        text: feature.cancelReason || `Feature #${feature.id} cancelled before merge.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: {
          featureId: feature.id,
          featurePlanId: feature.featurePlanId,
          projectKey: feature.projectKey,
          previousStatus: before.status,
          pullRequestUrl: feature.pullRequestUrl
        }
      });
      try {
        revalidateQueuedFeaturePlans(this.database, feature.projectKey);
      } catch {
        // best-effort
      }
      return feature;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown feature cancellation error.";
      if (/not found/i.test(message)) throw notFoundError(message);
      if (/cannot be cancelled|already merged/i.test(message)) throw conflictError(message);
      throw validationError(message);
    }
  }

  replanFeaturePlan(
    origin: CommandOrigin,
    featurePlanId: number,
    input: ReplanFeaturePlanInput
  ): FeaturePlanWriteResult {
    let before: FeaturePlanDetails | null = null;
    try {
      before = this.database.getFeaturePlanDetails(featurePlanId);
      const result = this.database.replanFeaturePlan({
        id: featurePlanId,
        objective: input.objective,
        acceptanceCriteria: input.acceptanceCriteria,
        taskIds: input.taskIds,
        taskContracts: input.taskContracts,
        idempotencyKey: input.idempotencyKey
      });
      if (result.applied) {
        this.database.addEvent({
          source: origin.channel,
          type: "feature_plan.replanned",
          text: result.plan.objective,
          userId: origin.userId ?? null,
          username: origin.username ?? null,
          metadata: {
            featurePlanId: result.plan.id,
            projectKey: result.plan.projectKey,
            previousRevision: before.plan.revision,
            revision: result.plan.revision,
            previousTaskIds: before.tasks.map((task) => task.taskId),
            taskIds: result.tasks.map((task) => task.taskId),
            acceptanceCriteriaCount: result.plan.acceptanceCriteria.length
          }
        });
      }
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  prepareTask(origin: CommandOrigin, taskId: number, worktreesRoot: string): PrepareTaskOutcome {
    let task: TaskRecord;
    try {
      task = this.database.getTask(taskId);
    } catch (error) {
      throw notFoundError(error instanceof Error ? error.message : `Task not found: ${taskId}`);
    }

    if (!task.projectKey) {
      const failure = validationError(`Task #${task.id} has no project.`);
      this.recordPrepareFailure(origin, task.id, failure.details);
      throw failure;
    }

    if (task.branchName || task.worktreePath) {
      const failure = conflictError(`Task #${task.id} already has a worktree.`);
      this.recordPrepareFailure(origin, task.id, failure.details);
      throw failure;
    }

    const project = this.database.getProjectByKey(task.projectKey);
    const validationErrors = validateGitProject(project);
    if (validationErrors.length > 0) {
      const failure = validationError(validationErrors.join("\n"), validationErrors);
      this.recordPrepareFailure(origin, task.id, failure.details);
      throw failure;
    }

    let baseline;
    try {
      baseline = prepareFeatureTaskBaseline(this.database, task, project, worktreesRoot);
    } catch (error) {
      const failure = conflictError(
        error instanceof Error ? error.message : "Feature Task baseline preparation failed."
      );
      this.recordPrepareFailure(origin, task.id, failure.details);
      throw failure;
    }
    const plan = createWorktreePlan(project, task, worktreesRoot, baseline);
    const result = createGitWorktree(project, plan);
    if (!result.ok) {
      const failure = conflictError(result.stderr || result.stdout || "git worktree failed.");
      this.recordPrepareFailure(origin, task.id, failure.details);
      throw failure;
    }

    const updatedTask = this.database.updateTaskWorktree({
      id: task.id,
      status: "planning",
      branchName: plan.branchName,
      worktreePath: plan.worktreePath,
      baseBranch: plan.baseBranch ?? project.defaultBranch
    });

    this.database.addEvent({
      source: origin.channel,
      type: "task.prepared",
      text: plan.branchName,
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      taskId: updatedTask.id,
      metadata: {
        branchName: plan.branchName,
        worktreePath: plan.worktreePath,
        baseBranch: plan.baseBranch ?? project.defaultBranch,
        dependencyTaskIds: baseline.dependencyTaskIds
      }
    });

    return { task: updatedTask, branchName: plan.branchName, worktreePath: plan.worktreePath };
  }

  private recordPrepareFailure(origin: CommandOrigin, taskId: number, errors: string[]) {
    this.database.addEvent({
      source: origin.channel,
      type: "task.prepare_failed",
      text: errors.join("\n"),
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      taskId
    });
  }

  pauseFeaturePlan(origin: CommandOrigin, featurePlanId: number, reason?: string | null): FeaturePlanDetails {
    try {
      const result = this.database.pauseFeaturePlan(featurePlanId, reason, origin.userId ?? null, origin.username ?? null);
      this.database.addEvent({
        source: origin.channel,
        type: "feature_plan.paused",
        text: result.plan.pauseReason || `Feature Plan #${result.plan.id} paused.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: { featurePlanId: result.plan.id, projectKey: result.plan.projectKey }
      });
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  resumeFeaturePlan(origin: CommandOrigin, featurePlanId: number): FeaturePlanDetails {
    try {
      const result = this.database.resumeFeaturePlan(featurePlanId, origin.userId ?? null, origin.username ?? null);
      this.database.addEvent({
        source: origin.channel,
        type: "feature_plan.resumed",
        text: `Feature Plan #${result.plan.id} resumed.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: { featurePlanId: result.plan.id, projectKey: result.plan.projectKey }
      });
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  updateFeaturePlanPriority(origin: CommandOrigin, featurePlanId: number, priority: number): FeaturePlanDetails {
    try {
      const result = this.database.updateFeaturePlanPriority(featurePlanId, priority, origin.userId ?? null, origin.username ?? null);
      this.database.addEvent({
        source: origin.channel,
        type: "feature_plan.priority_updated",
        text: `Feature Plan #${result.plan.id} priority updated to ${priority}.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: { featurePlanId: result.plan.id, priority }
      });
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  addFeaturePlanDependency(origin: CommandOrigin, featurePlanId: number, dependsOnFeaturePlanId: number): FeaturePlanDetails {
    try {
      const result = this.database.addFeaturePlanDependency(featurePlanId, dependsOnFeaturePlanId, origin.userId ?? null, origin.username ?? null);
      this.database.addEvent({
        source: origin.channel,
        type: "feature_plan.dependency_added",
        text: `Feature Plan #${featurePlanId} depends on #${dependsOnFeaturePlanId}.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: { featurePlanId, dependsOnFeaturePlanId }
      });
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  removeFeaturePlanDependency(origin: CommandOrigin, featurePlanId: number, dependsOnFeaturePlanId: number): FeaturePlanDetails {
    try {
      const result = this.database.removeFeaturePlanDependency(featurePlanId, dependsOnFeaturePlanId, origin.userId ?? null, origin.username ?? null);
      this.database.addEvent({
        source: origin.channel,
        type: "feature_plan.dependency_removed",
        text: `Dependency on #${dependsOnFeaturePlanId} removed from Feature Plan #${featurePlanId}.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: { featurePlanId, dependsOnFeaturePlanId }
      });
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  updateFeaturePlanQueueStatus(
    origin: CommandOrigin,
    featurePlanId: number,
    toStatus: import("../db.js").FeaturePlanQueueStatus,
    reason?: string | null
  ): FeaturePlanDetails {
    try {
      const result = this.database.updateFeaturePlanQueueStatus(featurePlanId, toStatus, reason, origin.userId ?? null, origin.username ?? null);
      this.database.addEvent({
        source: origin.channel,
        type: "feature_plan.status_changed",
        text: `Feature Plan #${featurePlanId} status changed to ${toStatus}.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: { featurePlanId, status: toStatus, reason: reason || null }
      });
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  getFeaturePlanEligibility(featurePlanId: number): import("../db.js").FeaturePlanEligibilityResult {
    try {
      return this.database.evaluateFeaturePlanEligibility(featurePlanId);
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  getFeaturePlanHistory(featurePlanId: number): import("../db.js").FeaturePlanHistoryRecord[] {
    try {
      return this.database.getFeaturePlanHistory(featurePlanId);
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  admitFeaturePlan(origin: CommandOrigin, featurePlanId: number): FeaturePlanDetails {
    try {
      const result = this.database.admitFeaturePlan(featurePlanId, origin.userId ?? null, origin.username ?? null);
      this.database.addEvent({
        source: origin.channel,
        type: "feature_plan.admitted",
        text: `Feature Plan #${featurePlanId} admitted to project writer lease.`,
        userId: origin.userId ?? null,
        username: origin.username ?? null,
        metadata: { featurePlanId }
      });
      return result;
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  revalidateFeaturePlanQueue(projectKey?: string | null): FeaturePlanDetails[] {
    try {
      return revalidateQueuedFeaturePlans(this.database, projectKey || undefined);
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  listFeaturePlanQueue(projectKey?: string | null): FeaturePlanDetails[] {
    try {
      return this.database.listFeaturePlanQueue(projectKey || undefined);
    } catch (error) {
      throw this.toFeaturePlanCommandError(error);
    }
  }

  private toFeaturePlanCommandError(error: unknown): never {
    const message = error instanceof Error ? error.message : "Unknown feature plan error.";
    if (/not found/i.test(message)) throw notFoundError(message);
    if (/already associated|already used|cannot be|cancelled|conflict|dirty|cherry-pick|secret guard|diff whitespace|checkpoint|changed after|Invalid Feature Plan status transition/i.test(message)) {
      throw conflictError(message);
    }
    if (/Cyclic dependency|Self-dependencies|Cross-project|must be|positive integer|required|at least/i.test(message)) {
      throw validationError(message);
    }
    throw validationError(message);
  }

  private recordImprovementDecision(origin: CommandOrigin, improvement: ImprovementProposalRecord): void {
    this.database.addEvent({
      source: origin.channel,
      type: `improvement.${improvement.status}`,
      text: improvement.title,
      userId: origin.userId ?? null,
      username: origin.username ?? null,
      metadata: {
        improvementId: improvement.id,
        decisionNote: improvement.decisionNote,
        taskId: improvement.taskId,
        featurePlanId: improvement.featurePlanId
      }
    });
  }
}
