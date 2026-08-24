import { AntigravityProvider } from "./antigravity.js";
import { ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";
import { CustomCliProvider } from "./custom-cli.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { mergeCustomProviders, readCustomProviders } from "./provider-config.js";
import { AgentRegistry } from "./registry.js";
import type { AgentProvider } from "./types.js";
import type { MaestroConfig } from "../config.js";
import type { MaestroDatabase } from "../db.js";

/**
 * Build the provider registry used by every local surface.
 *
 * Keeping this composition in the core prevents the development dashboard,
 * packaged desktop app and CLI-backed runtime from silently using different
 * provider lists or limits.
 */
export function createAgentRegistry(config: MaestroConfig, database: MaestroDatabase): AgentRegistry {
  const providerLimits = { maxRuntimeMs: config.runtime.providerMaxRuntimeMs };
  const providers: AgentProvider[] = [
    new CodexProvider({
      ...providerLimits,
      inactivityTimeoutMs: config.runtime.codexInactivityTimeoutMs,
      model: config.runtime.codexModel
    }),
    new ClaudeProvider({
      ...providerLimits,
      inactivityTimeoutMs: config.runtime.claudeInactivityTimeoutMs,
      model: config.runtime.claudeModel
    })
  ];

  if (config.runtime.antigravityEnabled) {
    providers.push(new AntigravityProvider({
      model: config.runtime.antigravityModel,
      effort: config.runtime.antigravityEffort ?? "medium",
      autoConfigurePermissions: true,
      executionLimits: {
        ...providerLimits,
        inactivityTimeoutMs: config.runtime.antigravityInactivityTimeoutMs
      }
    }));
  }

  const customProviders = mergeCustomProviders(config.runtime.customProviders, readCustomProviders());
  for (const customConfig of customProviders) {
    if (customConfig.endpointUrl) {
      providers.push(new OpenAICompatibleProvider(customConfig));
    } else {
      providers.push(new CustomCliProvider(customConfig, {
        executionLimits: providerLimits,
        model: customConfig.model
      }));
    }
  }

  return new AgentRegistry(providers, undefined, Date.now, database);
}
