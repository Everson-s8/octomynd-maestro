import { loadConfig, validateRuntimeConfig } from "./config.js";
import { createDatabase } from "./db.js";

const config = loadConfig();
const errors = validateRuntimeConfig(config);

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

const database = createDatabase(config.databasePath);
const lastEvent = database.getLastEvent();
const projects = database.listProjects();
database.close();

console.log("Maestro smoke check passed.");
console.log(`Project: ${config.projectName}`);
console.log("Telegram token: configured.");
console.log(config.telegram.allowedUserId ? "Telegram access: restricted." : "Telegram access: unrestricted.");
console.log(`Database: ${config.databasePath}`);
console.log(`Projects: ${projects.length}`);
console.log(lastEvent ? `Last event: ${lastEvent.type}` : "Last event: none.");
