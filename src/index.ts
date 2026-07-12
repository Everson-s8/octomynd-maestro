import path from "node:path";
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

const config = loadConfig();
const errors = validateRuntimeConfig(config);

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

const database = createDatabase(config.databasePath);
const agentRegistry = new AgentRegistry([new CodexProvider(), new ClaudeProvider()]);
const bot = createTelegramBot(config, database);
const goalNotifier = createTelegramGoalNotifier(
  config,
  database,
  (chatId, text) => bot.api.sendMessage(chatId, text)
);
const goalCoordinator = new GoalCoordinator(
  database,
  agentRegistry,
  path.join(path.dirname(config.databasePath), "runs"),
  15 * 60_000,
  deliverGoalToDraftPullRequest,
  goalNotifier
);
const recoveredGoals = goalCoordinator.recoverWaitingRuns();
const dashboardServer = config.dashboard.enabled
  ? await startDashboardServer({ config, database, goalCoordinator })
  : null;

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

void bot.start({
  onStart: (botInfo) => {
    console.log(`Telegram bot started as @${botInfo.username}.`);
  }
});

function shutdown() {
  console.log("Stopping Maestro.");
  bot.stop();
  goalCoordinator.shutdown();
  if (dashboardServer) {
    dashboardServer.close(() => database.close());
  } else {
    database.close();
  }
}
