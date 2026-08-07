import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { SkillCatalog } from "../src/skills/catalog.js";
import { SkillCurator } from "../src/skills/curator.js";
import { SkillEvaluationHarness } from "../src/skills/evaluation.js";
import { SkillLifecycleService, suggestSkillProposalQualifiedName } from "../src/skills/lifecycle.js";
import { SkillVersionStore } from "../src/skills/store.js";

let tempDir: string;
let database: MaestroDatabase;
let store: SkillVersionStore;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-skill-lifecycle-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
  store = new SkillVersionStore(database, path.join(tempDir, "managed-skill-versions"));
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("agent-owned Skill draft linkage", () => {
  it("links a requested draft only to an agent-owned candidate version and never auto-activates it", () => {
    const improvement = database.createImprovementProposal({
      category: "skill",
      title: "Reuse governed retry procedure",
      rationale: "Two completed Features used the same retry sequence.",
      proposedChange: "Package the retry sequence as a reusable Skill.",
      evidence: ["task:9"],
      risk: "low",
      projectKey: "maestro"
    });
    const suggestedQualifiedName = suggestSkillProposalQualifiedName(improvement.title);
    const proposal = database.createSkillProposal({
      improvementProposalId: improvement.id,
      suggestedQualifiedName,
      evidence: ["task:9"],
      provenance: { improvementProposalId: improvement.id }
    });
    expect(proposal.status).toBe("requested");

    const service = new SkillLifecycleService(database, {
      store,
      harness: new SkillEvaluationHarness(database, store),
      curator: new SkillCurator(database)
    });

    expect(service.reconcileSkillProposalDrafts()).toEqual([]);

    const sourceRoot = path.join(tempDir, "skills");
    const skillName = suggestedQualifiedName.slice(suggestedQualifiedName.indexOf(":") + 1);
    writeAgentOwnedSkill(sourceRoot, skillName, "Retry procedure body");
    const metadata = new SkillCatalog([{ scope: "repository", path: sourceRoot }]).discover().skills[0]!;
    const registered = store.register(metadata);
    expect(registered.status).toBe("candidate");

    const linked = service.reconcileSkillProposalDrafts();
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({
      id: proposal.id,
      status: "linked",
      qualifiedName: suggestedQualifiedName,
      skillVersionRecordId: registered.id
    });
    expect(database.getSkillVersion(registered.id).status).toBe("candidate");
    expect(database.getSkillByQualifiedName(suggestedQualifiedName).activeVersionId).toBeNull();

    expect(service.reconcileSkillProposalDrafts()).toEqual([]);
  });
});

describe("promotion gates, rollback and archival", () => {
  it("rolls back to a previously approved version without erasing history", () => {
    const sourceRoot = path.join(tempDir, "skills");
    writeAgentOwnedSkill(sourceRoot, "delivery-checklist", "First revision");
    const first = store.register(discoverOne(sourceRoot));
    passEvaluation(first.id);
    database.updateSkillVersionStatus(first.id, "evaluated");
    database.updateSkillVersionStatus(first.id, "approved");
    const activatedFirst = database.activateSkillVersion(first.id);
    expect(activatedFirst.status).toBe("active");

    fs.writeFileSync(
      path.join(sourceRoot, "delivery-checklist", "SKILL.md"),
      skillMarkdown("delivery-checklist", "Second revision")
    );
    const second = store.register(discoverOne(sourceRoot));
    passEvaluation(second.id);
    database.updateSkillVersionStatus(second.id, "evaluated");
    database.updateSkillVersionStatus(second.id, "approved");
    const activatedSecond = database.activateSkillVersion(second.id);
    expect(activatedSecond.status).toBe("active");
    expect(database.getSkillVersion(first.id).status).toBe("approved");

    expect(() => database.rollbackSkillVersion(second.id)).toThrow("already active");

    const rolledBack = database.rollbackSkillVersion(first.id);
    expect(rolledBack.status).toBe("active");
    expect(database.getSkillVersion(second.id).status).toBe("approved");
    expect(database.getSkillByQualifiedName("repository:delivery-checklist").activeVersionId).toBe(first.versionId);
  });

  it("keeps protected ownership from being archived automatically but allows explicit human archival", () => {
    const sourceRoot = path.join(tempDir, "skills");
    writeSystemOwnedSkill(sourceRoot, "final-feature-review", "System procedure");
    const version = store.register(discoverOne(sourceRoot));
    passEvaluation(version.id);
    database.updateSkillVersionStatus(version.id, "evaluated");
    database.updateSkillVersionStatus(version.id, "approved");
    const active = database.activateSkillVersion(version.id);

    expect(() => database.archiveSkillVersion(active.id, "curator")).toThrow(
      "Automatic archival is restricted to agent-owned Skills"
    );
    const archived = database.archiveSkillVersion(active.id, "human");
    expect(archived.status).toBe("retired");
    expect(database.getSkillByQualifiedName("repository:final-feature-review").activeVersionId).toBeNull();

    const restored = database.restoreSkillVersion(archived.id);
    expect(restored.status).toBe("approved");
    const reactivated = database.activateSkillVersion(restored.id);
    expect(reactivated.status).toBe("active");
  });

  it("auto-archives only stale, agent-owned active versions through the Curator", () => {
    const sourceRoot = path.join(tempDir, "skills");
    writeAgentOwnedSkill(sourceRoot, "stale-agent-skill", "Agent procedure");
    const version = store.register(discoverOne(sourceRoot));
    passEvaluation(version.id);
    database.updateSkillVersionStatus(version.id, "evaluated");
    database.updateSkillVersionStatus(version.id, "approved");
    const active = database.activateSkillVersion(version.id);
    const farFuture = new Date(Date.now() + 40 * 24 * 60 * 60_000);

    const curator = new SkillCurator(database, { staleDays: 30 });
    const dryRun = curator.dryRun(farFuture);
    const entry = dryRun.entries.find((item) => item.qualifiedName === "repository:stale-agent-skill")!;
    expect(entry.action).toBe("archive_stale_agent_skill");
    expect(entry.autoApplicable).toBe(true);
    expect(database.getSkillByQualifiedName("repository:stale-agent-skill").activeVersionId).toBe(active.versionId);

    const { archived } = curator.applyAutomaticArchival(farFuture);
    expect(archived).toEqual(["repository:stale-agent-skill"]);
    expect(database.getSkillByQualifiedName("repository:stale-agent-skill").activeVersionId).toBeNull();
    expect(database.getSkillVersion(active.id).status).toBe("retired");
  });

  it("keeps a recently used agent-owned Skill out of the Curator's archive report", () => {
    const sourceRoot = path.join(tempDir, "skills");
    writeAgentOwnedSkill(sourceRoot, "actively-used-skill", "Agent procedure");
    const version = store.register(discoverOne(sourceRoot));
    passEvaluation(version.id);
    database.updateSkillVersionStatus(version.id, "evaluated");
    database.updateSkillVersionStatus(version.id, "approved");
    const active = database.activateSkillVersion(version.id);
    const run = database.createGoalRun(database.createTask("use the active Skill").id);
    database.pinGoalSkill({
      runId: run.id,
      skillVersionRecordId: active.id,
      triggerReason: "Explicitly selected for implementation.",
      invocationMode: "explicit"
    });
    const step = database.createGoalStep(run.id, "implementing", "codex");
    database.recordSkillUsage({
      runId: run.id,
      stepId: step.id,
      skillVersionRecordId: active.id,
      provider: "codex",
      phase: "implementing",
      outcome: "completed",
      durationMs: 10,
      estimatedTokens: 5
    });

    expect(database.getSkillUsageSummary(active.id).usageCount).toBe(1);
    const entry = new SkillCurator(database, { staleDays: 30 }).dryRun().entries
      .find((item) => item.qualifiedName === "repository:actively-used-skill")!;
    expect(entry.action).toBe("none");
    expect(entry.usageCount).toBe(1);
    expect(entry.lastUsedAt).not.toBeNull();
  });

  it("never proposes automatic archival for user or system owned Skills", () => {
    const sourceRoot = path.join(tempDir, "skills");
    writeSystemOwnedSkill(sourceRoot, "protected-skill", "System procedure");
    const version = store.register(discoverOne(sourceRoot));
    passEvaluation(version.id);
    database.updateSkillVersionStatus(version.id, "evaluated");
    database.updateSkillVersionStatus(version.id, "approved");
    const active = database.activateSkillVersion(version.id);
    const farFuture = new Date(Date.now() + 40 * 24 * 60 * 60_000);

    const curator = new SkillCurator(database, { staleDays: 30 });
    const { archived, report } = curator.applyAutomaticArchival(farFuture);
    expect(archived).toEqual([]);
    const entry = report.entries.find((item) => item.qualifiedName === "repository:protected-skill")!;
    expect(entry.action).toBe("archive_stale_agent_skill");
    expect(entry.autoApplicable).toBe(false);
    expect(database.getSkillByQualifiedName("repository:protected-skill").activeVersionId).toBe(active.versionId);
  });
});

function discoverOne(root: string) {
  const snapshot = new SkillCatalog([{ scope: "repository", path: root }]).discover();
  expect(snapshot.issues).toEqual([]);
  expect(snapshot.skills).toHaveLength(1);
  return snapshot.skills[0]!;
}

function writeAgentOwnedSkill(root: string, name: string, body: string): void {
  const skillPath = path.join(root, name);
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(path.join(skillPath, "SKILL.md"), skillMarkdown(name, body));
  fs.writeFileSync(path.join(skillPath, "maestro.yaml"), [
    "schemaVersion: 1",
    "owner: agent",
    "risk: low",
    "allowImplicitInvocation: false",
    "capabilities: [coding]",
    `operatingSystems: [${process.platform}]`,
    "network: none",
    "readScopes: ['src']",
    "writeScopes: []",
    "maxRuntimeMs: 30000",
    "maxOutputChars: 8000"
  ].join("\n"));
}

function writeSystemOwnedSkill(root: string, name: string, body: string): void {
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
    "writeScopes: []",
    "maxRuntimeMs: 30000",
    "maxOutputChars: 8000"
  ].join("\n"));
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

function passEvaluation(skillVersionRecordId: number): void {
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
