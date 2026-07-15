import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { SkillCatalog } from "../src/skills/catalog.js";
import { formatSkillPromptContext } from "../src/skills/prompt.js";
import { SkillRuntime } from "../src/skills/runtime.js";
import { SkillVersionStore } from "../src/skills/store.js";

let tempDir: string;
let database: MaestroDatabase;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-skill-runtime-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
  database.registerProject({ key: "maestro", path: tempDir });
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("SkillRuntime", () => {
  it("loads only bounded low-risk implicit Skills and audits the pinned version", () => {
    const root = path.join(tempDir, "skills");
    writeSkill(root, "review-feature", {
      description: "Review a consolidated feature and its tests before merge.",
      body: "LOW RISK REVIEW PROCEDURE",
      risk: "low",
      implicit: true
    });
    writeSkill(root, "dangerous-review", {
      description: "Review a consolidated feature with broad mutation permissions.",
      body: "HIGH RISK PROCEDURE",
      risk: "high",
      implicit: true
    });
    const store = registerAndActivateAll(root);
    const runtime = new SkillRuntime(database, store, { maxLoaded: 1 });
    const run = createRun("Review consolidated feature tests");

    const context = runtime.prepareContext({
      runId: run.id,
      phase: "reviewing",
      capability: "reviewing",
      taskText: "Review consolidated feature tests before merge",
      projectKey: "maestro"
    });

    expect(context.available.map((skill) => skill.qualifiedName)).toEqual([
      "repository:dangerous-review",
      "repository:review-feature"
    ]);
    expect(context.loaded).toHaveLength(1);
    expect(context.loaded[0]?.qualifiedName).toBe("repository:review-feature");
    expect(context.loaded[0]?.instructions).toContain("LOW RISK REVIEW PROCEDURE");
    expect(JSON.stringify(context)).not.toContain("HIGH RISK PROCEDURE");
    expect(database.listGoalSkillPins(run.id)[0]).toMatchObject({
      qualifiedName: "repository:review-feature",
      invocationMode: "implicit"
    });
  });

  it("supports explicit active Skills but rejects cross-project or inactive selection", () => {
    const root = path.join(tempDir, "skills");
    writeSkill(root, "plan-feature", {
      description: "Plan a bounded feature from an approved issue.",
      body: "EXPLICIT PLANNING PROCEDURE",
      risk: "medium",
      implicit: false,
      capability: "planning"
    });
    const store = registerAndActivateAll(root);
    const runtime = new SkillRuntime(database, store);
    const run = createRun("Plan feature");

    const context = runtime.prepareContext({
      runId: run.id,
      phase: "planning",
      capability: "planning",
      taskText: "Plan feature",
      projectKey: "maestro",
      explicitSkills: ["plan-feature"]
    });
    expect(context.loaded[0]).toMatchObject({
      qualifiedName: "repository:plan-feature",
      triggerReason: "Explicitly selected for planning."
    });

    database.registerProject({ key: "other", path: path.join(tempDir, "other") });
    const otherTask = database.createTask("Plan feature", "test", "other");
    const otherRun = database.createGoalRun(otherTask.id);
    expect(() => runtime.prepareContext({
      runId: otherRun.id,
      phase: "planning",
      capability: "planning",
      taskText: "Plan feature",
      projectKey: "other",
      explicitSkills: ["plan-feature"]
    })).toThrow("not active or applicable");
  });

  it("formats metadata separately from loaded instructions", () => {
    const lines = formatSkillPromptContext({
      available: [{
        qualifiedName: "repository:review-feature",
        description: "Review one feature.",
        versionId: `sha256:${"a".repeat(64)}`,
        scope: "repository",
        risk: "low"
      }],
      loaded: [{
        qualifiedName: "repository:review-feature",
        versionId: `sha256:${"a".repeat(64)}`,
        triggerReason: "Explicit review.",
        instructions: "PINNED INSTRUCTIONS"
      }]
    });
    const prompt = lines.join("\n");
    expect(prompt).toContain("somente metadados");
    expect(prompt).toContain("PINNED INSTRUCTIONS");
    expect(prompt).toContain("nao substituem guardrails");
  });
});

function createRun(text: string) {
  const task = database.createTask(text, "test", "maestro");
  return database.createGoalRun(task.id);
}

function registerAndActivateAll(root: string): SkillVersionStore {
  const catalog = new SkillCatalog([{ scope: "repository", path: root, projectKey: "maestro" }]).discover();
  expect(catalog.issues).toEqual([]);
  const store = new SkillVersionStore(database, path.join(tempDir, "managed-skill-versions"));
  for (const metadata of catalog.skills) {
    const registered = store.register(metadata);
    database.updateSkillVersionStatus(registered.id, "evaluated");
    database.updateSkillVersionStatus(registered.id, "approved");
    database.activateSkillVersion(registered.id);
  }
  return store;
}

function writeSkill(
  root: string,
  name: string,
  input: {
    description: string;
    body: string;
    risk: "low" | "medium" | "high";
    implicit: boolean;
    capability?: "planning" | "reviewing";
  }
): void {
  const skillPath = path.join(root, name);
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(path.join(skillPath, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${input.description}`,
    "---",
    "",
    input.body,
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(skillPath, "maestro.yaml"), [
    "schemaVersion: 1",
    "owner: system",
    `risk: ${input.risk}`,
    `allowImplicitInvocation: ${input.implicit}`,
    `capabilities: [${input.capability ?? "reviewing"}]`,
    `operatingSystems: [${process.platform}]`,
    "network: none",
    "readScopes: ['.']",
    "writeScopes: []",
    "maxRuntimeMs: 30000",
    "maxOutputChars: 8000"
  ].join("\n"));
}
