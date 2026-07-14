import path from "node:path";
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
const agentRegistry = new AgentRegistry([new CodexProvider(), new ClaudeProvider()]);
let goalCoordinator!: GoalCoordinator;
let backlogAutopilot!: BacklogAutopilot;
const bot = createTelegramBot(config, database, {
  cancelTask: (taskId) => goalCoordinator.cancel(taskId),
  autopilotStatus: () => backlogAutopilot?.snapshot() ?? null
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
  { enabled: config.runtime.tokenEfficient }
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
backlogAutopilot = new BacklogAutopilot(database, goalCoordinator, {
  ...config.autopilot,
  worktreesRoot: config.worktreesPath
});
reviewCoordinator.start();
featureCoordinator.start();
featureAssemblyCoordinator.start();
const recoveredGoals = goalCoordinator.recoverWaitingRuns();
const dashboardServer = config.dashboard.enabled
  ? await startDashboardServer({
    config,
    database,
    goalCoordinator,
    reviewCoordinator,
    featureCoordinator,
    backlogAutopilot
  })
  : null;
backlogAutopilot.start();

bot.catch((error) => {
  console.error("Telegram bot error:", error.error instanceof Error ? error.error.message : "unknown error");
});

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`Starting Maestro for ${config.projectName}.`);
console.log("Telegram token loaded: yes.");
console.log(config.telegram.allowedUserId ? "Telegram access: restricted." : "Telegram access: unrestricted.");
if (dashboardServer) {
  console.log(`Dashboard: http://${config.dashboard.host}:${config.dashboard.port}`);
}
if (recoveredGoals > 0) {
  console.log(`Goals waiting for providers: ${recoveredGoals}. Automatic retry scheduled.`);
}
console.log(`Backlog autopilot: ${config.autopilot.enabled ? "enabled" : "disabled"}.`);
console.log(`Token-efficient runtime: ${config.runtime.tokenEfficient ? "enabled" : "disabled"}.`);
console.log(`Execution environment: ${environmentFingerprint.id}.`);

void bot.start({
  onStart: (botInfo) => {
    console.log(`Telegram bot started as @${botInfo.username}.`);
  }
});

function shutdown() {
  console.log("Stopping Maestro.");
  bot.stop();
  backlogAutopilot.shutdown();
  reviewCoordinator.shutdown();
  featureCoordinator.shutdown();
  featureAssemblyCoordinator.shutdown();
  goalCoordinator.shutdown();
  if (dashboardServer) {
    dashboardServer.close(() => database.close());
  } else {
    database.close();
  }
}
