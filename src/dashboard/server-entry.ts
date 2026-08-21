import { loadConfig, validateRuntimeConfig } from "../config.js";
import { createDatabase } from "../db.js";
import { startDashboardServer } from "./server.js";

const config = loadConfig();
const errors = validateRuntimeConfig(config, process.env, { requireTelegram: false });
if (errors.length > 0) {
  errors.forEach((error) => console.error(error));
  process.exit(1);
}

const database = createDatabase(config.databasePath);
const server = await startDashboardServer({ config, database, runtimeMode: "dashboard" });

console.log(`Maestro dashboard API: http://${config.dashboard.host}:${config.dashboard.port}`);

function shutdown() {
  server.close(() => database.close());
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
