import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { SkillCatalog } from "../src/skills/catalog.js";
import { SkillVersionStore } from "../src/skills/store.js";

let tempDir: string;
let database: MaestroDatabase;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-skill-store-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("SkillVersionStore", () => {
  it("snapshots immutable versions and pins only an active approved version to a Goal", () => {
    const sourceRoot = path.join(tempDir, "skills");
    const skillPath = writeSkill(sourceRoot, "implement-task-safely", "First governed procedure");
    const metadata = discoverOne(sourceRoot);
    const store = new SkillVersionStore(database, path.join(tempDir, "managed-skill-versions"));

    const first = store.register(metadata);
    expect(first.status).toBe("candidate");
    expect(first.snapshotPath).not.toBe(skillPath);
    expect(store.readSkillMarkdown(first)).toContain("First governed procedure");

    fs.writeFileSync(
      path.join(skillPath, "SKILL.md"),
      skillMarkdown("implement-task-safely", "Second unapproved procedure")
    );
    expect(store.readSkillMarkdown(first)).toContain("First governed procedure");
    expect(store.readSkillMarkdown(first)).not.toContain("Second unapproved procedure");

    recordPassingEvaluation(first.id);
    const evaluated = database.updateSkillVersionStatus(first.id, "evaluated");
    const approved = database.updateSkillVersionStatus(evaluated.id, "approved");
    const active = database.activateSkillVersion(approved.id);
    expect(active.status).toBe("active");
    expect(database.getSkillByQualifiedName(active.qualifiedName).activeVersionId).toBe(active.versionId);

    const task = database.createTask("Use a governed Skill");
    const run = database.createGoalRun(task.id);
    const pin = database.pinGoalSkill({
      runId: run.id,
      skillVersionRecordId: active.id,
      triggerReason: "Explicitly selected for bounded implementation.",
      invocationMode: "explicit"
    });
    expect(pin).toMatchObject({
      runId: run.id,
      qualifiedName: "repository:implement-task-safely",
      versionId: active.versionId,
      invocationMode: "explicit"
    });
    const step = database.createGoalStep(run.id, "implementing", "codex");
    const usage = database.recordSkillUsage({
      runId: run.id,
      stepId: step.id,
      skillVersionRecordId: active.id,
      provider: "codex",
      phase: "implementing",
      outcome: "completed",
      durationMs: 40,
      estimatedTokens: 25
    });
    expect(database.listSkillUsage(run.id)).toEqual([usage]);

    const second = store.register(discoverOne(sourceRoot));
    expect(second.versionId).not.toBe(first.versionId);
    expect(second.status).toBe("candidate");
    expect(() => database.pinGoalSkill({
      runId: run.id,
      skillVersionRecordId: second.id,
      triggerReason: "Unsafe candidate selection.",
      invocationMode: "explicit"
    })).toThrow("active approved version");
    expect(() => database.recordSkillUsage({
      runId: run.id,
      stepId: step.id,
      skillVersionRecordId: second.id,
      provider: "codex",
      phase: "implementing",
      outcome: "completed",
      durationMs: 1,
      estimatedTokens: 1
    })).toThrow("pinned");
    expect(database.listGoalSkillPins(run.id)).toEqual([pin]);
  });

  it("preserves pins across database migration and never persists Skill instructions in records", () => {
    const sourceRoot = path.join(tempDir, "skills");
    writeSkill(sourceRoot, "review-feature", "PRIVATE REVIEW INSTRUCTIONS");
    const store = new SkillVersionStore(database, path.join(tempDir, "managed-skill-versions"));
    const registered = store.register(discoverOne(sourceRoot));
    recordPassingEvaluation(registered.id);
    database.updateSkillVersionStatus(registered.id, "evaluated");
    database.updateSkillVersionStatus(registered.id, "approved");
    const active = database.activateSkillVersion(registered.id);
    const run = database.createGoalRun(database.createTask("Review a feature").id);
    database.pinGoalSkill({
      runId: run.id,
      skillVersionRecordId: active.id,
      triggerReason: "Final consolidated review.",
      invocationMode: "explicit"
    });
    const databasePath = path.join(tempDir, "maestro.db");
    database.close();

    database = createDatabase(databasePath);
    const reopenedStore = new SkillVersionStore(database, path.join(tempDir, "managed-skill-versions"));
    const persisted = database.getSkillVersion(active.id);
    expect(database.listGoalSkillPins(run.id)).toHaveLength(1);
    expect(JSON.stringify(database.listSkills())).not.toContain("PRIVATE REVIEW INSTRUCTIONS");
    expect(JSON.stringify(database.listSkillVersions())).not.toContain("PRIVATE REVIEW INSTRUCTIONS");
    expect(reopenedStore.readSkillMarkdown(persisted)).toContain("PRIVATE REVIEW INSTRUCTIONS");
  });

  it("does not allow immutable version metadata to be overwritten", () => {
    const sourceRoot = path.join(tempDir, "skills");
    writeSkill(sourceRoot, "plan-feature", "Plan one bounded feature");
    const store = new SkillVersionStore(database, path.join(tempDir, "managed-skill-versions"));
    const metadata = discoverOne(sourceRoot);
    const registered = store.register(metadata);

    expect(() => database.registerSkillVersion({
      qualifiedName: metadata.qualifiedName,
      name: metadata.name,
      description: metadata.description,
      scope: metadata.scope,
      projectKey: metadata.projectKey,
      versionId: metadata.versionId,
      contentHash: metadata.contentHash,
      snapshotPath: path.join(tempDir, "different-snapshot"),
      policy: metadata.policy,
      fileCount: metadata.fileCount,
      totalBytes: metadata.totalBytes
    })).toThrow("Immutable Skill version conflicts");
    expect(registered.status).toBe("candidate");
  });
});

function discoverOne(root: string) {
  const snapshot = new SkillCatalog([{ scope: "repository", path: root }]).discover();
  expect(snapshot.issues).toEqual([]);
  expect(snapshot.skills).toHaveLength(1);
  return snapshot.skills[0]!;
}

function writeSkill(root: string, name: string, body: string): string {
  const skillPath = path.join(root, name);
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(path.join(skillPath, "SKILL.md"), skillMarkdown(name, body));
  fs.writeFileSync(path.join(skillPath, "maestro.yaml"), [
    "schemaVersion: 1",
    "owner: system",
    "risk: low",
    "allowImplicitInvocation: false",
    "capabilities: [coding]",
    `operatingSystems: [${process.platform}]`,
    "network: none",
    "readScopes: ['src']",
    "writeScopes: ['src']",
    "maxRuntimeMs: 30000",
    "maxOutputChars: 8000"
  ].join("\n"));
  return skillPath;
}

function skillMarkdown(name: string, body: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} procedure. Use only after explicit selection.`,
    "---",
    "",
    body,
    ""
  ].join("\n");
}

function recordPassingEvaluation(skillVersionRecordId: number): void {
  database.recordSkillEvaluation({
    skillVersionRecordId,
    status: "passed",
    qualityScore: 1,
    durationMs: 1,
    estimatedTokens: 10,
    attempts: 1,
    failures: 0,
    securityPassed: true,
    regressionDetected: false,
    baselineVersionId: null,
    checks: [{ id: "test", type: "content", status: "passed", message: "passed" }]
  });
}
