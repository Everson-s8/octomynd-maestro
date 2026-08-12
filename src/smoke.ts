import fs from "node:fs";
import path from "node:path";
import { loadConfig, validateRuntimeConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { detectProviders, isGhAvailable, runConfigWizard } from "./config/wizard.js";
import { CodexProvider } from "./agents/codex.js";
import { ClaudeProvider } from "./agents/claude.js";
import { AntigravityProvider } from "./agents/antigravity.js";
import { AgentRegistry } from "./agents/registry.js";
import type { AgentCapability, AgentProvider } from "./agents/types.js";

const envPath = path.join(process.cwd(), ".env");
const envLocalPath = path.join(process.cwd(), ".env.local");
if (!fs.existsSync(envPath) && !fs.existsSync(envLocalPath)) {
  runConfigWizard();
}

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

const providersInfo = detectProviders();
const readyProviders = providersInfo.filter((p) => p.available);
const ghAvailable = isGhAvailable();

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

const registry = new AgentRegistry(agentProviders, undefined, Date.now);

const capabilities: AgentCapability[] = [
  "planning",
  "coding",
  "testing",
  "reviewing",
  "improvement_reviewing",
  "research",
  "conversation"
];

const unroutableCapabilities: AgentCapability[] = [];
for (const cap of capabilities) {
  const routed = await registry.route(cap);
  if (!routed) {
    unroutableCapabilities.push(cap);
  }
}

console.log("Maestro smoke check passed.");
console.log(`Project: ${config.projectName}`);
console.log(`Database: ${config.databasePath}`);
console.log(`Projects: ${projects.length}`);
console.log(`Providers available: ${readyProviders.length} (${providersInfo.map((p) => `${p.label}:${p.available ? "ready" : "offline"}`).join(", ")})`);
console.log(`GitHub CLI (gh): ${ghAvailable ? "available" : "not installed (optional, local mode active)"}`);

if (readyProviders.length === 0) {
  console.log("Warning: No AI providers currently online. Maestro will remain idle until at least one provider CLI or API key is available.");
} else if (unroutableCapabilities.length === 0) {
  console.log(`Single-provider capability routing: verified OK (${readyProviders.length === 1 ? `100% routed via ${readyProviders[0].label}` : "multi-provider active"}).`);
} else {
  console.error(`Error: The following capabilities could not be routed: ${unroutableCapabilities.join(", ")}`);
  process.exit(1);
}

console.log(lastEvent ? `Last event: ${lastEvent.type}` : "Last event: none.");
