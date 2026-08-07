import path from "node:path";
import { AntigravityProvider } from "./agents/antigravity.js";
import type { AgentProvider } from "./agents/types.js";
import { captureEnvironmentFingerprint, ensureExecutionContract } from "./execution/contract.js";
import { ClaudeProvider } from "./agents/claude.js";
import { CodexProvider } from "./agents/codex.js";
import { AgentRegistry } from "./agents/registry.js";
import { loadConfig, validateRuntimeConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { createTelegramBot } from "./telegram/bot.js";
import { startDashboardServer } from "./dashboard/server.js";
import { GoalCoordinator } from "./goals/coordinator.js";
import { deliverGoalToDraftPullRequest } from "./goals/delivery.js";
import { createTelegramGoalNotifier } from "./telegram/notifications.js";
import { createTelegramReviewNotifier } from "./telegram/notifications.js";
import { createTelegramGoalProgressNotifier, createTelegramReviewSyncNotifier } from "./telegram/notifications.js";
import { ReviewCoordinator } from "./reviews/coordinator.js";
import { BacklogAutopilot } from "./backlog/autopilot.js";
import { FeatureCoordinator } from "./features/coordinator.js";
import { FeatureAssemblyCoordinator } from "./features/assembly.js";
import {
  createTelegramFeatureAssemblyNotifier,
  createTelegramFeatureBlockedNotifier,
  createTelegramFeatureNotifier
} from "./telegram/notifications.js";
import { EnvironmentDoctor } from "./environment/doctor.js";
import { DeterministicValidationRunner } from "./validation/runner.js";
import { RestrictedImprovementReviewCoordinator } from "./improvements/coordinator.js";
import { ImprovementReviewWorker } from "./improvements/worker.js";
import { createTelegramImprovementCandidateNotifier } from "./telegram/notifications.js";
import { bootstrapSkills } from "./skills/bootstrap.js";
import { SkillCurator } from "./skills/curator.js";
import { SkillCuratorWorker } from "./skills/curator-worker.js";
import { SkillEvaluationHarness } from "./skills/evaluation.js";
import { SkillVersionStore } from "./skills/store.js";
import type { SkillLifecycleRuntime } from "./skills/lifecycle.js";
import { WorkGraphCoordinator } from "./work-graphs/coordinator.js";

const config = loadConfig();
const errors = validateRuntimeConfig(config);

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

ensureExecutionContract(config.execution);
const database = createDatabase(config.databasePath);
const environmentFingerprint = captureEnvironmentFingerprint(config.execution);
database.addEvent({
  source: "maestro",
  type: "environment.fingerprint",
  text: environmentFingerprint.id,
  metadata: { fingerprint: environmentFingerprint }
});
const providerLimits = { maxRuntimeMs: config.runtime.providerMaxRuntimeMs };
const agentProviders: AgentProvider[] = [
  new CodexProvider({
    ...providerLimits,
    inactivityTimeoutMs: config.runtime.codexInactivityTimeoutMs
  }),
  new ClaudeProvider({
    ...providerLimits,
    inactivityTimeoutMs: config.runtime.claudeInactivityTimeoutMs
  })
];
if (config.runtime.antigravityEnabled) {
  agentProviders.push(new AntigravityProvider({
    model: config.runtime.antigravityModel,
    effort: config.runtime.antigravityEffort ?? "medium",
    executionLimits: {
      ...providerLimits,
      inactivityTimeoutMs: config.runtime.antigravityInactivityTimeoutMs
    }
  }));
}
const agentRegistry = new AgentRegistry(agentProviders, undefined, Date.now, database);
const environmentDoctor = new EnvironmentDoctor(config, database, agentRegistry);
const validationRunner = new DeterministicValidationRunner();
const skillBootstrap = config.skills.enabled
  ? bootstrapSkills({
      database,
      catalogPath: config.skills.catalogPath,
      versionsPath: config.skills.versionsPath,
      projectKey: config.skills.projectKey
    })
  : null;
if (skillBootstrap) {
  database.addEvent({
    source: "maestro",
    type: "skills.bootstrap_completed",
    text: `${skillBootstrap.active.length} governed built-in Skill(s) active.`,
    metadata: { active: skillBootstrap.active }
  });
}
const skillLifecycleRuntime: SkillLifecycleRuntime | undefined = config.skills.enabled
  ? (() => {
    const store = new SkillVersionStore(database, config.skills.versionsPath);
    return {
      store,
      harness: new SkillEvaluationHarness(database, store),
      curator: new SkillCurator(database, { staleDays: config.skills.curator.staleDays })
    };
  })()
  : undefined;
const skillCuratorWorker = skillLifecycleRuntime && config.skills.curator.autoArchiveEnabled
  ? new SkillCuratorWorker(database, skillLifecycleRuntime.curator, {
    pollIntervalMs: config.skills.curator.pollIntervalMs
  })
  : null;
let goalCoordinator!: GoalCoordinator;
let backlogAutopilot!: BacklogAutopilot;
const workGraphCoordinator = new WorkGraphCoordinator(
  database,
  agentRegistry,
  path.join(path.dirname(config.databasePath), "runs"),
  15 * 60_000,
  undefined,
  undefined,
  (graph) => {
    try {
      goalCoordinator.resume(graph.runId);
    } catch {
      // The owning Goal is not waiting for this graph (e.g. it drove the graph inline and
      // will observe the terminal result directly), already active, or already terminal.
    }
  }
);
const bot = createTelegramBot(config, database, {
  cancelTask: (taskId) => goalCoordinator.cancel(taskId),
  autopilotStatus: () => backlogAutopilot?.snapshot() ?? null,
  environmentDoctor: (projectKey) => environmentDoctor.inspectProject(projectKey),
  providerStatus: () => agentRegistry.snapshot(),
  workGraphRuntime: workGraphCoordinator
});
const goalNotifier = createTelegramGoalNotifier(
  config,
  database,
  (chatId, text) => bot.api.sendMessage(chatId, text)
);
const goalProgressNotifier = createTelegramGoalProgressNotifier(
  config,
  database,
  (chatId, text) => bot.api.sendMessage(chatId, text)
);
goalCoordinator = new GoalCoordinator(
  database,
  agentRegistry,
  path.join(path.dirname(config.databasePath), "runs"),
  15 * 60_000,
  deliverGoalToDraftPullRequest,
  goalNotifier,
  goalProgressNotifier,
  undefined,
  { enabled: config.runtime.tokenEfficient },
  (taskId) => environmentDoctor.preflightTask(taskId),
  validationRunner,
  skillBootstrap?.runtime,
  config.runtime.goalDeadlineMs,
  { mode: config.workGraph.adoptionMode },
  workGraphCoordinator
);
const reviewNotifier = createTelegramReviewNotifier(
  config,
  database,
  (chatId, text) => bot.api.sendMessage(chatId, text)
);
const reviewSyncNotifier = createTelegramReviewSyncNotifier(
  config,
  database,
  (chatId, text) => bot.api.sendMessage(chatId, text)
);
const featureNotifier = createTelegramFeatureNotifier(
  config,
  database,
  (chatId, text) => bot.api.sendMessage(chatId, text)
);
const featureBlockedNotifier = createTelegramFeatureBlockedNotifier(
  config,
  database,
  (chatId, text) => bot.api.sendMessage(chatId, text)
);
const featureAssemblyNotifier = createTelegramFeatureAssemblyNotifier(
  config,
  database,
  (chatId, text) => bot.api.sendMessage(chatId, text)
);
const improvementCandidateNotifier = createTelegramImprovementCandidateNotifier(
  config,
  database,
  (chatId, text) => bot.api.sendMessage(chatId, text)
);
const reviewCoordinator = new ReviewCoordinator(
  database,
  goalCoordinator,
  undefined,
  reviewNotifier,
  reviewSyncNotifier
);
const featureCoordinator = new FeatureCoordinator(
  database,
  agentRegistry,
  path.join(path.dirname(config.databasePath), "feature-runs"),
  undefined,
  featureNotifier,
  featureBlockedNotifier
);
const featureAssemblyCoordinator = new FeatureAssemblyCoordinator(
  database,
  config.worktreesPath,
  undefined,
  undefined,
  featureAssemblyNotifier
);
const improvementReviewWorker = new ImprovementReviewWorker(
  database,
  new RestrictedImprovementReviewCoordinator(agentRegistry),
  improvementCandidateNotifier
);
backlogAutopilot = new BacklogAutopilot(database, goalCoordinator, {
  ...config.autopilot,
  worktreesRoot: config.worktreesPath
});
reviewCoordinator.start();
featureCoordinator.start();
featureAssemblyCoordinator.start();
improvementReviewWorker.start();
const recoveredWorkGraphs = workGraphCoordinator.recoverActiveGraphs();
const recoveredGoals = goalCoordinator.recoverWaitingRuns((run) => workGraphCoordinator.isRunActive(run.id));
const dashboardServer = config.dashboard.enabled
  ? await startDashboardServer({
    config,
    database,
    runtimeMode: "full",
    goalCoordinator,
    reviewCoordinator,
    featureCoordinator,
    backlogAutopilot,
    environmentDoctor,
    agentRegistry,
    workGraphRuntime: workGraphCoordinator,
    skillLifecycle: skillLifecycleRuntime
  })
  : null;
backlogAutopilot.start();
skillCuratorWorker?.start();
void environmentDoctor.inspectAll().catch((error) => {
  database.addEvent({
    source: "maestro",
    type: "environment.doctor_failed",
    text: error instanceof Error ? error.message : "Environment Doctor failed."
  });
});

bot.catch((error) => {
  console.error("Telegram bot error:", error.error instanceof Error ? error.error.message : "unknown error");
});

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

console.log(`Starting Maestro for ${config.projectName}.`);
console.log("Telegram token loaded: yes.");
console.log(config.telegram.allowedUserId ? "Telegram access: restricted." : "Telegram access: unrestricted.");
if (dashboardServer) {
  console.log(`Dashboard: http://${config.dashboard.host}:${config.dashboard.port}`);
}
if (recoveredGoals > 0) {
  console.log(`Goals waiting for providers: ${recoveredGoals}. Automatic retry scheduled.`);
}
if (recoveredWorkGraphs > 0) {
  console.log(`Work Graphs recovered: ${recoveredWorkGraphs}.`);
}
console.log(`Backlog autopilot: ${config.autopilot.enabled ? "enabled" : "disabled"}.`);
console.log(`Skill Curator auto-archive: ${skillCuratorWorker ? "enabled" : "disabled (dry-run only)"}.`);
console.log(`Token-efficient runtime: ${config.runtime.tokenEfficient ? "enabled" : "disabled"}.`);
console.log(`Work Graph adoption: ${config.workGraph.adoptionMode}.`);
console.log(`Execution environment: ${environmentFingerprint.id}.`);

void bot.start({
  onStart: (botInfo) => {
    console.log(`Telegram bot started as @${botInfo.username}.`);
  }
});

let shutdownStarted = false;

async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log("Stopping Maestro.");
  bot.stop();
  backlogAutopilot.shutdown();
  reviewCoordinator.shutdown();
  featureCoordinator.shutdown();
  featureAssemblyCoordinator.shutdown();
  improvementReviewWorker.shutdown();
  skillCuratorWorker?.shutdown();
  await workGraphCoordinator.shutdown();
  goalCoordinator.shutdown();
  if (dashboardServer) {
    await new Promise<void>((resolve, reject) => {
      dashboardServer.close((error) => error ? reject(error) : resolve());
    });
    database.close();
  } else {
    database.close();
  }
}
