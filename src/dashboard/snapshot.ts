import { MaestroConfig } from "../config.js";
import { MaestroDatabase, TaskRecord } from "../db.js";
import { listReviewQueue } from "../reviews/evidence.js";
import { redactSensitiveText, sanitizePublicMetadata, truncateForDisplay } from "../security/redaction.js";
import { BacklogAutopilotSnapshot } from "../backlog/autopilot.js";
import type { EnvironmentDoctorReport } from "../environment/types.js";
import type { AgentProviderSnapshot } from "../agents/registry.js";
import type { AgentProviderId } from "../agents/types.js";
import { ApplicationCommands } from "../commands/application-commands.js";
import { SkillCurator } from "../skills/curator.js";

import { buildGoalObservability } from "../goals/observability.js";

export type AgentPresence = {
  id: AgentProviderId | "telegram";
  label: string;
  state: "ready" | "working" | "attention" | "offline";
  detail: string;
  taskId?: number;
  projectKey?: string;
  phase?: string;
};

export function providerAgentPresence(
  config: MaestroConfig,
  database: MaestroDatabase,
  providers: AgentProviderSnapshot[]
): AgentPresence[] {
  const tasks = database.listTasks(80);
  const goals = database.listGoalRuns(30);
  const working = currentProviderWork(database, tasks, goals);
  return [
    ...providers.map((provider): AgentPresence => {
      const current = working.get(provider.id);
      if (provider.state === "working" && current) return current;
      return {
        id: provider.id,
        label: provider.label,
        state: provider.state === "ready"
          ? "ready"
          : provider.state === "working"
            ? "working"
            : provider.state === "offline"
              ? "offline"
              : "attention",
        detail: provider.state === "cooldown" && provider.cooldownUntil
          ? `${provider.detail} Cooldown ate ${provider.cooldownUntil}.`
          : provider.detail
      };
    }),
    telegramPresence(config)
  ];
}

const EVENT_TEXT_MAX_LENGTH = 500;

export function buildDashboardSnapshot(
  config: MaestroConfig,
  database: MaestroDatabase,
  agents?: AgentPresence[],
  autopilot?: BacklogAutopilotSnapshot
) {
  const projects = database.listProjects();
  const tasks = database.listTasks(80);
  const allEvents = database.listEvents(200);
  const events = allEvents.slice(0, 40);
  const improvements = database.listImprovementProposals(40);
  const goals = database.listGoalRuns(30);
  const counts = database.countTasksByStatus();
  const improvementCounts = database.countImprovementProposalsByStatus();
  const reviewQueue = listReviewQueue(database);
  const features = database.listFeatures(30);
  const featurePlans = database.listFeaturePlans(30);
  const completedFeaturePlanIds = new Set(
    features
      .filter((feature) => feature.status === "completed" && feature.featurePlanId)
      .map((feature) => feature.featurePlanId as number)
  );
  const activeFeaturePlanCount = featurePlans.filter((plan) => (
    plan.status !== "completed" && plan.status !== "cancelled" && !completedFeaturePlanIds.has(plan.id)
  )).length;
  const skills = database.listSkills();
  const skillProposals = database.listSkillProposals();
  const commands = new ApplicationCommands(database);
  const workGraphs = commands.listWorkGraphs(30);

  return {
    generatedAt: new Date().toISOString(),
    daemon: {
      name: config.projectName,
      state: "online" as const,
      access: config.telegram.allowedUserId ? "restricted" : "unrestricted",
      dashboardHost: config.dashboard.host
    },
    autopilot: autopilot ?? {
      enabled: config.autopilot.enabled,
      state: config.autopilot.enabled ? "idle" as const : "disabled" as const,
      maxConcurrentGoals: config.autopilot.maxConcurrentGoals,
      pollIntervalMs: config.autopilot.pollIntervalMs,
      runningGoals: goals.filter((goal) => goal.status === "running").length,
      waitingProviderGoals: goals.filter((goal) => goal.status === "waiting_provider").length,
      queuedTasks: counts.queued ?? 0,
      lastAction: "snapshot_only",
      lastTickAt: null
    },
    summary: {
      projects: projects.length,
      // Only count active (non-paused/non-disabled) execution providers so the
      // overview metric matches the providers screen (both show "what is called").
      providersConnected: (() => {
        const policy = database.getProviderPolicySnapshot();
        const modeBy = new Map(policy.controls.map((c) => [c.providerId, c.mode]));
        return (agents ?? [])
          .filter((a) => a.id !== "telegram")
          .filter((a) => (modeBy.get(a.id) ?? "enabled") === "enabled").length;
      })(),
      activeTasks: tasks.filter(isActiveTask).length,
      queuedTasks: counts.queued ?? 0,
      humanGates: reviewQueue.length + (counts.ready_to_merge ?? 0) + (improvementCounts.candidate ?? 0),
      improvementCandidates: improvementCounts.candidate ?? 0,
      plannedFeaturePlans: activeFeaturePlanCount,
      activeGoals: goals.filter((goal) => ["running", "waiting_provider"].includes(goal.status)).length,
      completedTasks: counts.done ?? 0
    },
    costSummary: database.getCostSummary(),
    skills: skills.map((skill) => {
      const active = skill.activeVersionId
        ? database.getSkillVersionByCoordinates(skill.qualifiedName, skill.activeVersionId)
        : null;
      const evaluation = active ? database.getLatestSkillEvaluation(active.id) : null;
      const comparison = evaluation ? database.getSkillEvaluationComparison(evaluation.id) : null;
      return {
        qualifiedName: skill.qualifiedName,
        description: redactSensitiveText(skill.description),
        scope: skill.scope,
        projectKey: skill.projectKey,
        owner: skill.owner,
        risk: skill.risk,
        activeVersionId: skill.activeVersionId,
        evaluation: evaluation ? {
          status: evaluation.status,
          qualityScore: evaluation.qualityScore,
          durationMs: evaluation.durationMs,
          estimatedTokens: evaluation.estimatedTokens,
          attempts: evaluation.attempts,
          failures: evaluation.failures,
          securityPassed: evaluation.securityPassed,
          regressionDetected: evaluation.regressionDetected,
          comparison,
          createdAt: evaluation.createdAt
        } : null
      };
    }),
    skillUsage: database.listSkillUsage(undefined, 40),
    skillProposals: skillProposals.map((proposal) => ({
      ...proposal,
      evidence: proposal.evidence.map(redactSensitiveText),
      decisionNote: proposal.decisionNote ? redactSensitiveText(proposal.decisionNote) : null
    })),
    skillCuratorReport: new SkillCurator(database, { staleDays: config.skills.curator.staleDays }).dryRun(),
    projects: projects.map((project) => {
      const projectTasks = tasks.filter((task) => task.projectKey === project.key);
      const currentWork = goals.flatMap((goal) => {
        const task = tasks.find((item) => item.id === goal.taskId);
        if (task?.projectKey !== project.key || !["running", "waiting_provider"].includes(goal.status)) return [];
        const step = database.listGoalSteps(goal.id).at(-1);
        return [{ taskId: task.id, phase: goal.currentPhase, provider: step?.provider ?? null }];
      });
      return {
        id: project.id,
        key: project.key,
        name: project.name,
        defaultBranch: project.defaultBranch,
        canonicalHeadSha: project.canonicalHeadSha ?? null,
        remoteHeadSha: project.remoteHeadSha ?? null,
        syncState: project.syncState ?? "unknown",
        lastFetchAt: project.lastFetchAt ?? null,
        taskCount: projectTasks.length,
        activeTaskCount: projectTasks.filter(isActiveTask).length,
        workingAgents: [...new Set(currentWork.map((item) => item.provider).filter(Boolean))],
        currentWork
      };
    }),
    tasks: tasks.map((task) => ({
      id: task.id,
      projectKey: task.projectKey,
      projectName: task.projectName,
      parentTaskId: task.parentTaskId ?? null,
      text: redactSensitiveText(task.text),
      status: task.status,
      source: task.source,
      baseCommitSha: task.baseCommitSha ?? null,
      headCommitSha: task.headCommitSha ?? null,
      mergedCommitSha: task.mergedCommitSha ?? null,
      branchName: task.branchName ? redactSensitiveText(task.branchName) : null,
      worktreePrepared: Boolean(task.worktreePath),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    })),
    events: events.map((event) => ({
      id: event.id,
      source: event.source,
      type: event.type,
      text: truncateForDisplay(redactSensitiveText(event.text), EVENT_TEXT_MAX_LENGTH),
      taskId: event.taskId,
      createdAt: event.createdAt,
      metadata: sanitizePublicMetadata(event.metadata)
    })),
    improvements: improvements.map((item) => ({
      ...item,
      title: redactSensitiveText(item.title),
      rationale: redactSensitiveText(item.rationale),
      proposedChange: redactSensitiveText(item.proposedChange),
      evidence: item.evidence.map(redactSensitiveText),
      decisionNote: item.decisionNote ? redactSensitiveText(item.decisionNote) : null
    })),
    goals: goals.map((goal) => ({
      ...goal,
      lastError: goal.lastError
        ? truncateForDisplay(redactSensitiveText(goal.lastError), EVENT_TEXT_MAX_LENGTH)
        : null,
      observability: buildGoalObservability(database, goal)
    })),
    features: features.map((feature) => ({
      id: feature.id,
      projectKey: feature.projectKey,
      featurePlanId: feature.featurePlanId,
      name: redactSensitiveText(feature.name),
      objective: truncateForDisplay(redactSensitiveText(feature.objective), EVENT_TEXT_MAX_LENGTH),
      status: feature.status,
      branchName: redactSensitiveText(feature.branchName),
      pullRequestUrl: feature.pullRequestUrl,
      reviewerProvider: feature.reviewerProvider,
      reviewSummary: feature.reviewSummary
        ? truncateForDisplay(redactSensitiveText(feature.reviewSummary), EVENT_TEXT_MAX_LENGTH)
        : null,
      lastError: feature.lastError
        ? truncateForDisplay(redactSensitiveText(feature.lastError), EVENT_TEXT_MAX_LENGTH)
        : null,
      itemCount: database.listFeatureItems(feature.id).length,
      mergedAt: feature.mergedAt,
      cancelledAt: feature.cancelledAt,
      cancelReason: feature.cancelReason
        ? truncateForDisplay(redactSensitiveText(feature.cancelReason), EVENT_TEXT_MAX_LENGTH)
        : null,
      cancellable: !["completed", "merging", "cancelled"].includes(feature.status),
      createdAt: feature.createdAt,
      updatedAt: feature.updatedAt
    })),
    runtimeUpdate: (() => {
      const latest = database.getLatestRuntimeUpdate();
      if (!latest) return null;
      return {
        id: latest.id,
        featureId: latest.featureId,
        targetCommit: latest.targetCommit,
        previousCommit: latest.previousCommit,
        status: latest.status,
        error: latest.error ? truncateForDisplay(redactSensitiveText(latest.error), EVENT_TEXT_MAX_LENGTH) : null,
        createdAt: latest.createdAt,
        updatedAt: latest.updatedAt
      };
    })(),
    featurePlans: featurePlans.map((plan) => {
      const reconciledPlan = database.reconcileFeaturePlanStatus(plan.id);
      const tasks = database.listFeaturePlanTasks(plan.id);
      const integration = database.getFeaturePlanIntegrationDetailsByFeaturePlan(plan.id);
      const associatedFeature = database.findFeatureByFeaturePlanId(plan.id);
      const dependencies = database.listFeaturePlanDependencies(plan.id);
      const eligibility = database.evaluateFeaturePlanEligibility(plan.id);
      const lifecycleStatus = reconciledPlan.status === "cancelled"
        ? "cancelled"
        : reconciledPlan.status === "completed"
          ? "completed"
          : "active";
      const blockers = tasks
        .filter((task) => lifecycleStatus === "active" && task.taskStatus !== "awaiting_human")
        .map((task) => `Task #${task.taskId} is ${task.taskStatus}, waiting for the delivered Draft Work PR.`);
      if (!eligibility.eligible) {
        blockers.unshift(eligibility.reason);
      }
      return {
        id: plan.id,
        projectKey: plan.projectKey,
        projectName: plan.projectName,
        objective: truncateForDisplay(redactSensitiveText(plan.objective), EVENT_TEXT_MAX_LENGTH),
        acceptanceCriteria: plan.acceptanceCriteria.map((item) => (
          truncateForDisplay(redactSensitiveText(item), EVENT_TEXT_MAX_LENGTH)
        )),
        status: plan.status,
        priority: plan.priority,
        isPaused: plan.isPaused,
        pausedAt: plan.pausedAt,
        pauseReason: plan.pauseReason ? truncateForDisplay(redactSensitiveText(plan.pauseReason), EVENT_TEXT_MAX_LENGTH) : null,
        blockedAt: plan.blockedAt,
        blockedReason: plan.blockedReason ? truncateForDisplay(redactSensitiveText(plan.blockedReason), EVENT_TEXT_MAX_LENGTH) : null,
        admittedAt: plan.admittedAt,
        completedAt: plan.completedAt,
        lifecycleStatus,
        source: plan.source,
        revision: plan.revision,
        taskIds: tasks.map((task) => task.taskId),
        taskCount: tasks.length,
        dependsOnFeaturePlanIds: dependencies.map((dep) => dep.dependsOnFeaturePlanId),
        eligibility,
        tasks: tasks.map((task) => ({
          id: task.taskId,
          position: task.position,
          text: truncateForDisplay(redactSensitiveText(task.taskText), EVENT_TEXT_MAX_LENGTH),
          status: task.taskStatus,
          objective: truncateForDisplay(redactSensitiveText(task.contract.objective), EVENT_TEXT_MAX_LENGTH),
          acceptanceCriteria: task.contract.acceptanceCriteria.map((criterion) => (
            truncateForDisplay(redactSensitiveText(criterion), EVENT_TEXT_MAX_LENGTH)
          )),
          excludedScope: task.contract.excludedScope.map(redactSensitiveText),
          dependsOnTaskIds: task.contract.dependsOnTaskIds,
          mutationScope: task.contract.mutationScope,
          parallelMode: task.contract.parallelMode
        })),
        eligible: eligibility.eligible && lifecycleStatus === "active" && tasks.length > 0,
        blockers,
        feature: associatedFeature ? {
          id: associatedFeature.id,
          status: associatedFeature.status,
          pullRequestUrl: associatedFeature.pullRequestUrl
        } : null,
        integration: integration ? {
          status: integration.integration.status,
          checkpoint: integration.integration.checkpoint,
          lastError: integration.integration.lastError
            ? truncateForDisplay(redactSensitiveText(integration.integration.lastError), EVENT_TEXT_MAX_LENGTH)
            : null
        } : null,
        cancellable: !["completed", "cancelled"].includes(plan.status) && !integration && !associatedFeature,
        cancelledAt: plan.cancelledAt,
        cancelReason: plan.cancelReason
          ? truncateForDisplay(redactSensitiveText(plan.cancelReason), EVENT_TEXT_MAX_LENGTH)
          : null,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt
      };
    }),
    workGraphs,
    environments: latestEnvironmentReports(allEvents),
    reviewQueue,
    agents: agents ?? defaultAgentPresence(config, database, tasks, goals)
  };
}

function latestEnvironmentReports(events: ReturnType<MaestroDatabase["listEvents"]>): EnvironmentDoctorReport[] {
  const reports = new Map<string, EnvironmentDoctorReport>();
  for (const event of events) {
    if (event.type !== "environment.doctor") continue;
    const report = event.metadata.report as EnvironmentDoctorReport | undefined;
    if (!report?.projectKey || reports.has(report.projectKey)) continue;
    reports.set(report.projectKey, report);
  }
  return [...reports.values()].map((report) => ({
    ...report,
    summary: truncateForDisplay(redactSensitiveText(report.summary), EVENT_TEXT_MAX_LENGTH),
    recommendedAction: truncateForDisplay(redactSensitiveText(report.recommendedAction), EVENT_TEXT_MAX_LENGTH),
    checks: report.checks.map((item) => ({
      ...item,
      summary: truncateForDisplay(redactSensitiveText(item.summary), EVENT_TEXT_MAX_LENGTH),
      evidence: []
    }))
  }));
}

function defaultAgentPresence(
  config: MaestroConfig,
  database: MaestroDatabase,
  tasks: TaskRecord[],
  goals: ReturnType<MaestroDatabase["listGoalRuns"]>
): AgentPresence[] {
  const working = currentProviderWork(database, tasks, goals);
  return [
    working.get("codex") ?? {
      id: "codex",
      label: "Codex",
      state: "attention",
      detail: "Provider state is available only in the full runtime."
    },
    working.get("claude") ?? {
      id: "claude",
      label: "Claude",
      state: "attention",
      detail: "Provider state is available only in the full runtime."
    },
    telegramPresence(config)
  ];
}

function currentProviderWork(
  database: MaestroDatabase,
  tasks: TaskRecord[],
  goals: ReturnType<MaestroDatabase["listGoalRuns"]>
): Map<string, AgentPresence> {
  const working = new Map<string, AgentPresence>();
  for (const goal of goals.filter((item) => item.status === "running")) {
    const task = tasks.find((item) => item.id === goal.taskId);
    const step = database.listGoalSteps(goal.id).at(-1);
    if (!task || !step || step.status !== "running") continue;
    working.set(step.provider, {
      id: step.provider as AgentProviderId,
      label: providerLabel(step.provider as AgentProviderId),
      state: "working",
      detail: `@${task.projectKey ?? "inbox"} · task #${task.id} · ${goal.currentPhase}`,
      taskId: task.id,
      projectKey: task.projectKey ?? undefined,
      phase: goal.currentPhase
    });
  }
  return working;
}

function providerLabel(provider: AgentProviderId): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude";
  return "Gemini Antigravity";
}

function telegramPresence(config: MaestroConfig): AgentPresence {
  const isConfigured = Boolean(
    config.telegram.botToken && config.telegram.botToken !== "dummy_token_for_local_setup"
  );
  return {
    id: "telegram",
    label: "Telegram",
    state: isConfigured ? "ready" : "offline",
    detail: isConfigured
      ? config.telegram.allowedUserId
        ? "Bot restricted to the authorized user."
        : "Bot active (access restriction pending)."
      : "Bot disconnected (configure it through the UI or CLI)."
  };
}

function isActiveTask(task: TaskRecord): boolean {
  return !["done", "failed", "blocked", "rejected", "cancelled"].includes(task.status);
}
