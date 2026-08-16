import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addCustomProvider,
  mergeCustomProviders,
  PROVIDER_PRESETS,
  readCustomProviders,
  removeCustomProvider
} from "../src/agents/provider-config.js";
import type { AgentCapability } from "../src/agents/types.js";

let dir: string;
let envPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-prov-config-"));
  envPath = path.join(dir, ".env.local");
  fs.writeFileSync(envPath, "", "utf8"); // resolveEnvFilePath prefers .env.local when present
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("provider-config", () => {
  it("exposes curated presets incl. claude, codex, deepseek, ollama, anthropic", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("deepseek");
    expect(ids).toContain("ollama");
    expect(ids).toContain("opencode-go");
    expect(PROVIDER_PRESETS.every((p) => p.command && p.connectionHint)).toBe(true);
  });

  it("returns empty registered providers when no env file", () => {
    expect(readCustomProviders(dir)).toEqual([]);
  });

  it("adds a custom provider and persists MAESTRO_CUSTOM_PROVIDERS to .env.local", () => {
    const provider = {
      id: "my-cli",
      label: "My CLI",
      command: "mycli",
      args: ["--model", "x"],
      capabilities: ["planning", "coding", "reviewing"] as AgentCapability[],
      healthProbe: false,
      model: "x",
      models: ["x", "y"]
    };
    const result = addCustomProvider(provider, dir);
    expect(result.success).toBe(true);
    expect(result.envPath).toBe(envPath);
    expect(fs.existsSync(envPath)).toBe(true);

    const stored = readCustomProviders(dir);
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe("my-cli");
    expect(stored[0].command).toBe("mycli");

    const content = fs.readFileSync(envPath, "utf8");
    expect(content).toContain("MAESTRO_CUSTOM_PROVIDERS=");
  });

  it("updates in place when re-adding the same id and does not duplicate", () => {
    const base = { id: "p1", label: "P1", command: "p1", capabilities: ["coding"] as AgentCapability[], healthProbe: false };
    addCustomProvider(base, dir);
    addCustomProvider({ ...base, command: "p1v2", label: "P1 v2" }, dir);
    const stored = readCustomProviders(dir);
    expect(stored).toHaveLength(1);
    expect(stored[0].command).toBe("p1v2");
  });

  it("merges persisted providers over stale startup configuration", () => {
    const configured = [{ id: "p1", label: "Old", command: "old", capabilities: ["coding"] as AgentCapability[] }];
    const persisted = [
      { id: "p1", label: "Current", command: "current", capabilities: ["coding"] as AgentCapability[] },
      { id: "p2", label: "Second", command: "second", capabilities: ["testing"] as AgentCapability[] }
    ];

    expect(mergeCustomProviders(configured, persisted)).toEqual(persisted);
  });

  it("removes a registered provider", () => {
    addCustomProvider({ id: "a", label: "A", command: "a", capabilities: ["coding"] as AgentCapability[], healthProbe: false }, dir);
    addCustomProvider({ id: "b", label: "B", command: "b", capabilities: ["coding"] as AgentCapability[], healthProbe: false }, dir);
    const removal = removeCustomProvider("a", dir);
    expect(removal.removed).toBe(true);
    const stored = readCustomProviders(dir);
    expect(stored.map((p) => p.id)).toEqual(["b"]);
  });

  it("removes only Maestro-managed secrets that are no longer shared", () => {
    fs.writeFileSync(envPath, "SHARED_KEY=shared\nPRIVATE_KEY=private\n", "utf8");
    addCustomProvider({
      id: "a",
      label: "A",
      command: "a",
      capabilities: ["coding"] as AgentCapability[],
      apiKeyEnv: "SHARED_KEY",
      managedSecret: true
    }, dir);
    addCustomProvider({
      id: "b",
      label: "B",
      command: "b",
      capabilities: ["coding"] as AgentCapability[],
      apiKeyEnv: "SHARED_KEY"
    }, dir);
    addCustomProvider({
      id: "private",
      label: "Private",
      command: "private",
      capabilities: ["coding"] as AgentCapability[],
      apiKeyEnv: "PRIVATE_KEY",
      managedSecret: true
    }, dir);

    removeCustomProvider("a", dir);
    expect(fs.readFileSync(envPath, "utf8")).toContain("SHARED_KEY=shared");

    removeCustomProvider("private", dir);
    expect(fs.readFileSync(envPath, "utf8")).not.toContain("PRIVATE_KEY=private");
  });

  it("does not remove externally managed secrets", () => {
    fs.writeFileSync(envPath, "EXTERNAL_KEY=keep\n", "utf8");
    addCustomProvider({
      id: "external",
      label: "External",
      command: "external",
      capabilities: ["coding"] as AgentCapability[],
      apiKeyEnv: "EXTERNAL_KEY"
    }, dir);

    removeCustomProvider("external", dir);
    expect(fs.readFileSync(envPath, "utf8")).toContain("EXTERNAL_KEY=keep");
  });

  it("reports removed=false when the id is absent", () => {
    const removal = removeCustomProvider("missing", dir);
    expect(removal.removed).toBe(false);
  });

  it("tolerates invalid/malformed MAESTRO_CUSTOM_PROVIDERS and returns []", () => {
    fs.writeFileSync(envPath, "MAESTRO_CUSTOM_PROVIDERS=not-json\n", "utf8");
    expect(readCustomProviders(dir)).toEqual([]);
  });
});
