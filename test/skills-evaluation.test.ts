import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { bootstrapSkills } from "../src/skills/bootstrap.js";
import { SkillCatalog } from "../src/skills/catalog.js";
import { SkillEvaluationHarness } from "../src/skills/evaluation.js";
import { SkillVersionStore } from "../src/skills/store.js";

let tempDir: string;
let database: MaestroDatabase;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-skill-eval-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("SkillEvaluationHarness", () => {
  it("evaluates triggers, workflow content and script syntax before activation", () => {
    const root = path.join(tempDir, "skills");
    writeEvaluatedSkill(root, "review-feature", "REQUIRED GUARDRAIL", false);
    const store = new SkillVersionStore(database, path.join(tempDir, "versions"));
    const version = store.register(discoverOne(root));
    expect(() => database.updateSkillVersionStatus(version.id, "evaluated")).toThrow("passing");

    const evaluation = new SkillEvaluationHarness(database, store).evaluate(version.id);

    expect(evaluation).toMatchObject({
      status: "passed",
      qualityScore: 1,
      failures: 0,
      securityPassed: true,
      regressionDetected: false,
      attempts: 5
    });
    expect(evaluation.estimatedTokens).toBeGreaterThan(0);
    expect(database.getSkillVersion(version.id).status).toBe("evaluated");
    database.updateSkillVersionStatus(version.id, "approved");
    expect(database.activateSkillVersion(version.id).status).toBe("active");
  });

  it("blocks regressing versions and unsafe implicit write policies", () => {
    const root = path.join(tempDir, "skills");
    const packagePath = writeEvaluatedSkill(root, "review-feature", "REQUIRED GUARDRAIL", false);
    const store = new SkillVersionStore(database, path.join(tempDir, "versions"));
    const harness = new SkillEvaluationHarness(database, store);
    const first = store.register(discoverOne(root));
    expect(harness.evaluate(first.id).status).toBe("passed");
    database.updateSkillVersionStatus(first.id, "approved");
    database.activateSkillVersion(first.id);

    fs.writeFileSync(path.join(packagePath, "SKILL.md"), skillMarkdown("review-feature", "GUARDRAIL REMOVED"));
    const regressing = store.register(discoverOne(root));
    const regression = harness.evaluate(regressing.id);
    expect(regression.status).toBe("failed");
    expect(regression.regressionDetected).toBe(true);
    expect(regression.baselineVersionId).toBe(first.versionId);
    const comparison = database.getSkillEvaluationComparison(regression.id);
    expect(comparison).toMatchObject({
      baselineVersionId: first.versionId,
      durationDeltaMs: expect.any(Number),
      estimatedTokensDelta: expect.any(Number),
      attemptsDelta: 0,
      failuresDelta: 1
    });
    expect(comparison?.qualityDelta).toBeCloseTo(-0.2);
    expect(() => database.updateSkillVersionStatus(regressing.id, "evaluated")).toThrow("passing");

    const unsafeRoot = path.join(tempDir, "unsafe-skills");
    writeEvaluatedSkill(unsafeRoot, "unsafe-review", "REQUIRED GUARDRAIL", true);
    const unsafe = store.register(discoverOne(unsafeRoot));
    const unsafeEvaluation = harness.evaluate(unsafe.id);
    expect(unsafeEvaluation.status).toBe("failed");
    expect(unsafeEvaluation.securityPassed).toBe(false);
  });

  it("bootstraps only the evaluated built-in allowlist", () => {
    const result = bootstrapSkills({
      database,
      catalogPath: path.resolve("skills"),
      versionsPath: path.join(tempDir, "versions"),
      projectKey: "maestro"
    });

    expect(result.active.map((skill) => skill.qualifiedName).sort()).toEqual([
      "repository:diagnose-goal-failure",
      "repository:final-feature-review",
      "repository:implement-task-safely"
    ]);
    expect(database.listSkillEvaluations()).toHaveLength(3);
    expect(database.listSkillEvaluations().every((evaluation) => evaluation.status === "passed")).toBe(true);
  });
});

function discoverOne(root: string) {
  const snapshot = new SkillCatalog([{ scope: "repository", path: root, projectKey: "maestro" }]).discover();
  expect(snapshot.issues).toEqual([]);
  expect(snapshot.skills).toHaveLength(1);
  return snapshot.skills[0]!;
}

function writeEvaluatedSkill(root: string, name: string, body: string, unsafeImplicitWrite: boolean): string {
  const packagePath = path.join(root, name);
  fs.mkdirSync(path.join(packagePath, "evals"), { recursive: true });
  fs.writeFileSync(path.join(packagePath, "SKILL.md"), skillMarkdown(name, body));
  fs.writeFileSync(path.join(packagePath, "maestro.yaml"), [
    "schemaVersion: 1",
    "owner: system",
    "risk: low",
    `allowImplicitInvocation: ${unsafeImplicitWrite}`,
    "capabilities: [reviewing]",
    `operatingSystems: [${process.platform}]`,
    "network: none",
    "readScopes: ['.']",
    `writeScopes: ${unsafeImplicitWrite ? "['src']" : "[]"}`,
    "maxRuntimeMs: 30000",
    "maxOutputChars: 8000"
  ].join("\n"));
  fs.writeFileSync(path.join(packagePath, "evals", "cases.yaml"), [
    "schemaVersion: 1",
    "cases:",
    "  - id: positive",
    "    type: trigger",
    "    prompt: review the consolidated feature",
    "    phase: reviewing",
    "    capability: reviewing",
    "    expectMatch: true",
    "  - id: negative",
    "    type: trigger",
    "    prompt: implement database migration",
    "    phase: implementing",
    "    capability: coding",
    "    expectMatch: false",
    "  - id: workflow",
    "    type: content",
    "    requiredPhrases: ['REQUIRED GUARDRAIL']",
    "    forbiddenPhrases: ['LEAK SECRET']",
    ...(name === "review-feature" ? [
      "  - id: script",
      "    type: script_syntax",
      "    path: scripts/validate.mjs"
    ] : [])
  ].join("\n"));
  if (name === "review-feature") {
    fs.mkdirSync(path.join(packagePath, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(packagePath, "scripts", "validate.mjs"), "export const valid = true;\n");
  }
  return packagePath;
}

function skillMarkdown(name: string, body: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: Review one consolidated feature with deterministic evidence.",
    "---",
    "",
    body,
    ""
  ].join("\n");
}
