import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Antigravity allows workspace file reads/writes by default, but headless
 * command execution falls back to "ask". There is no TTY in a Maestro goal,
 * so the ask is soft-denied. Keep this list deliberately focused on common
 * development toolchains instead of granting command(*).
 */
export const ANTIGRAVITY_AUTONOMOUS_COMMAND_RULES = [
  "command(git)",
  "command(npm)",
  "command(node)",
  "command(npx)",
  "command(pnpm)",
  "command(yarn)",
  "command(bun)",
  "command(deno)",
  "command(python)",
  "command(python3)",
  "command(py)",
  "command(cargo)",
  "command(go)",
  "command(dotnet)",
  "command(git .*)",
  "command(npm .*)",
  "command(node .*)",
  "command(npx .*)",
  "command(pnpm .*)",
  "command(yarn .*)",
  "command(bun .*)",
  "command(deno .*)",
  "command(python .*)",
  "command(python3 .*)",
  "command(py .*)",
  "command(cargo .*)",
  "command(go .*)",
  "command(dotnet .*)"
] as const;

export type AntigravityPermissionStatus = {
  configured: boolean;
  settingsPath: string;
  requiredRules: string[];
  missingRules: string[];
};

type JsonObject = Record<string, unknown>;

export function resolveAntigravitySettingsPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".gemini", "antigravity-cli", "settings.json");
}

export function getAntigravityPermissionStatus(
  settingsPath = resolveAntigravitySettingsPath()
): AntigravityPermissionStatus {
  const settings = readSettings(settingsPath);
  const permissions = isObject(settings.permissions) ? settings.permissions : {};
  const allow = Array.isArray(permissions.allow)
    ? permissions.allow.filter((item): item is string => typeof item === "string")
    : [];
  const missingRules = ANTIGRAVITY_AUTONOMOUS_COMMAND_RULES.filter((rule) => !allow.includes(rule));
  return {
    configured: missingRules.length === 0,
    settingsPath,
    requiredRules: [...ANTIGRAVITY_AUTONOMOUS_COMMAND_RULES],
    missingRules
  };
}

export function configureAntigravityAutonomousPermissions(
  settingsPath = resolveAntigravitySettingsPath()
): AntigravityPermissionStatus {
  const settings = readSettings(settingsPath);
  const permissions = isObject(settings.permissions) ? settings.permissions : {};
  const allow = Array.isArray(permissions.allow)
    ? permissions.allow.filter((item): item is string => typeof item === "string")
    : [];
  const nextAllow = [...new Set([...allow, ...ANTIGRAVITY_AUTONOMOUS_COMMAND_RULES])];

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify({
      ...settings,
      permissions: {
        ...permissions,
        allow: nextAllow
      }
    }, null, 2)}\n`,
    "utf8"
  );

  return getAntigravityPermissionStatus(settingsPath);
}

function readSettings(settingsPath: string): JsonObject {
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return isObject(parsed) ? parsed : {};
  } catch {
    // Do not overwrite a malformed settings file through an implicit repair.
    // The caller gets a clear failure from the write operation instead of
    // silently destroying a user's Antigravity configuration.
    throw new Error("O settings.json do Antigravity nao contem JSON valido.");
  }
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
