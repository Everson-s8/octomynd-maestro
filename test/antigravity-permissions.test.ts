import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_AUTONOMOUS_COMMAND_RULES,
  configureAntigravityAutonomousPermissions,
  getAntigravityPermissionStatus,
  resolveAntigravitySettingsPath
} from "../src/agents/antigravity-permissions.js";

const tempPaths: string[] = [];

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) fs.rmSync(tempPath, { recursive: true, force: true });
});

describe("Antigravity autonomous permissions", () => {
  it("allows bounded arguments for common development commands without command(*)", () => {
    expect(ANTIGRAVITY_AUTONOMOUS_COMMAND_RULES).toContain("command(npm .*)");
    expect(ANTIGRAVITY_AUTONOMOUS_COMMAND_RULES).toContain("command(git .*)");
    expect(ANTIGRAVITY_AUTONOMOUS_COMMAND_RULES).not.toContain("command(*)");
  });

  it("uses the documented per-user settings location", () => {
    const home = path.join(os.tmpdir(), "maestro-home");
    expect(resolveAntigravitySettingsPath(home)).toBe(path.join(home, ".gemini", "antigravity-cli", "settings.json"));
  });

  it("merges development command rules without destroying existing settings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-agy-permissions-"));
    tempPaths.push(root);
    const settingsPath = path.join(root, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ agentMode: "accept-edits", permissions: { deny: ["command(sudo)"], allow: ["command(custom-tool)"] } }));

    const status = configureAntigravityAutonomousPermissions(settingsPath);
    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { agentMode: string; permissions: { deny: string[]; allow: string[] } };
    expect(status.configured).toBe(true);
    expect(status.missingRules).toEqual([]);
    expect(saved.agentMode).toBe("accept-edits");
    expect(saved.permissions.deny).toEqual(["command(sudo)"]);
    expect(saved.permissions.allow).toContain("command(custom-tool)");
    expect(saved.permissions.allow).toEqual(expect.arrayContaining([...ANTIGRAVITY_AUTONOMOUS_COMMAND_RULES]));
    expect(getAntigravityPermissionStatus(settingsPath).configured).toBe(true);
  });

  it("does not silently replace malformed settings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-agy-invalid-"));
    tempPaths.push(root);
    const settingsPath = path.join(root, "settings.json");
    fs.writeFileSync(settingsPath, "not-json");
    expect(() => configureAntigravityAutonomousPermissions(settingsPath)).toThrow(/valid JSON/);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe("not-json");
  });
});
