import { loadConfig, validateRuntimeConfig } from "../config.js";
import { createDatabase } from "../db.js";
import { startDashboardServer } from "./server.js";
import { stopAntigravitySession } from "../agents/antigravity-session.js";
import { createAgentRegistry } from "../agents/runtime.js";

const config = loadConfig();
const errors = validateRuntimeConfig(config, process.env, { requireTelegram: false });
if (errors.length > 0) {
  errors.forEach((error) => console.error(error));
  process.exit(1);
}

const database = createDatabase(config.databasePath);
const agentRegistry = createAgentRegistry(config, database);
agentRegistry.startHealthProbing();
const server = await startDashboardServer({ config, database, runtimeMode: "dashboard", agentRegistry });

console.log(`Maestro dashboard API: http://${config.dashboard.host}:${config.dashboard.port}`);

function shutdown() {
  stopAntigravitySession();
  agentRegistry.healthProber?.stop();
  server.close(() => database.close());
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
