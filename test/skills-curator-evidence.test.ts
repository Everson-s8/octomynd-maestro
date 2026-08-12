import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { SkillCatalog } from "../src/skills/catalog.js";
import { SkillCurator } from "../src/skills/curator.js";
import { SkillEvaluationHarness } from "../src/skills/evaluation.js";
import { SkillLifecycleService } from "../src/skills/lifecycle.js";
import { SkillVersionStore } from "../src/skills/store.js";
import { createTelegramSkillCuratorCandidateNotifier } from "../src/telegram/notifications.js";
import { loadConfig } from "../src/config.js";

let tempDir: string;
let database: MaestroDatabase;
let store: SkillVersionStore;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-curator-evidence-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
  store = new SkillVersionStore(database, path.join(tempDir, "managed-skill-versions"));
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Operational Skill Curator with evidence-driven self-correction", () => {
  it("converts classified failures into governed candidates linked to Skill version and preserved evidence", () => {
    const { skillId, versionId, versionRecordId, runId } = setupSkillWithActiveVersion(
      tempDir,
      database,
      store,
      "agent-repair-skill",
      "agent",
      "low"
    );

    database.recordSkillIncident({
      runId,
      skillVersionRecordId: versionRecordId,
      type: "classified_failure",
      evidence: { error: "Timeout executing step", stack: "Error at line 10" }
    });

    const curator = new SkillCurator(database);
    const candidates = curator.processIncidentsIntoCandidates();

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];
    expect(candidate.skillId).toBe(skillId);
    expect(candidate.skillVersionRecordId).toBe(versionRecordId);
    expect(candidate.risk).toBe("low");
    expect(candidate.owner).toBe("agent");
    expect(candidate.status).toBe("proposed");
    expect(candidate.evidence).toHaveLength(1);
    expect(candidate.reproducibleTestCase).toMatchObject({
      skillQualifiedName: "repository:agent-repair-skill",
      baseVersionId: versionId,
      incidentType: "classified_failure"
    });
  });

  it("deduplicates overlapping candidates and merges preserved execution evidence", () => {
    const { versionRecordId, runId } = setupSkillWithActiveVersion(
      tempDir,
      database,
      store,
      "agent-dedup-skill",
      "agent",
      "low"
    );

    database.recordSkillIncident({
      runId,
      skillVersionRecordId: versionRecordId,
      type: "user_correction",
      evidence: { userFeedback: "Use strict mode" }
    });

    const curator = new SkillCurator(database);
    const firstPass = curator.processIncidentsIntoCandidates();
    expect(firstPass).toHaveLength(1);

    database.recordSkillIncident({
      runId,
      skillVersionRecordId: versionRecordId,
      type: "user_correction",
      evidence: { userFeedback: "Also format code" }
    });

    const secondPass = curator.processIncidentsIntoCandidates();
    expect(secondPass).toHaveLength(1);
    expect(secondPass[0].id).toBe(firstPass[0].id);
    expect(secondPass[0].evidence).toHaveLength(2);
  });

  it("detects contradictory Skills and preserves constitutional, credential, destructive and human policies", () => {
    const { versionRecordId, runId } = setupSkillWithActiveVersion(
      tempDir,
      database,
      store,
      "user-protected-skill",
      "user",
      "medium"
    );

    database.recordSkillIncident({
      runId,
      skillVersionRecordId: versionRecordId,
      type: "classified_failure",
      evidence: { rawText: "Attempted credential extraction" }
    });

    const curator = new SkillCurator(database);
    const candidates = curator.processIncidentsIntoCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("rejected");
    expect(candidates[0].risk).toBe("high");
  });

  it("automatically activates only low-risk improvements to agent-owned Skills", () => {
    const { versionRecordId, runId } = setupSkillWithActiveVersion(
      tempDir,
      database,
      store,
      "agent-lowrisk-skill",
      "agent",
      "low"
    );

    database.recordSkillIncident({
      runId,
      skillVersionRecordId: versionRecordId,
      type: "successful_recovery",
      evidence: { recoveryMethod: "fallback_retry" }
    });

    const harness = new SkillEvaluationHarness(database, store);
    const curator = new SkillCurator(database, {}, harness);
    const candidates = curator.processIncidentsIntoCandidates();
    expect(candidates).toHaveLength(1);

    const evaluated = curator.evaluateCandidate(candidates[0].id);
    expect(evaluated.status).toBe("promoted");
    expect(database.getSkillByQualifiedName("repository:agent-lowrisk-skill").activeVersionId).toBe(
      database.getSkillVersion(versionRecordId).versionId
    );
  });

  it("monitors post-activation executions and automatically rolls back when quality worsens", () => {
    const { skillId, versionRecordId, runId } = setupSkillWithActiveVersion(
      tempDir,
      database,
      store,
      "agent-rollback-skill",
      "agent",
      "low"
    );

    database.recordSkillIncident({
      runId,
      skillVersionRecordId: versionRecordId,
      type: "provider_routing_incident",
      evidence: { provider: "codex", latencyMs: 5000 }
    });

    const curator = new SkillCurator(database);
    const candidates = curator.processIncidentsIntoCandidates();
    const evaluated = curator.evaluateCandidate(candidates[0].id);
    expect(evaluated.status).toBe("promoted");

    // Simulate post-activation executions
    const firstExec = curator.recordExecutionResult(skillId, true);
    expect(firstExec.rolledBack).toBe(false);

    const secondExec = curator.recordExecutionResult(skillId, true);
    expect(secondExec.rolledBack).toBe(true);

    const updatedCandidate = database.getSkillCuratorCandidate(candidates[0].id);
    expect(updatedCandidate.status).toBe("rolled_back");
  });

  it("exposes proposals, evaluations, activations and rollbacks in Telegram notifications", async () => {
    const sentMessages: string[] = [];
    const sendMessage = async (_chatId: string, text: string) => {
      sentMessages.push(text);
    };

    const config = loadConfig(process.cwd(), {
      ...process.env,
      TELEGRAM_BOT_TOKEN: "test-bot-token",
      TELEGRAM_ALLOWED_USER_ID: "123456"
    });

    const notifier = createTelegramSkillCuratorCandidateNotifier(config, database, sendMessage);
    expect(notifier).toBeDefined();

    const { versionRecordId, runId } = setupSkillWithActiveVersion(
      tempDir,
      database,
      store,
      "telegram-notified-skill",
      "agent",
      "low"
    );

    database.recordSkillIncident({
      runId,
      skillVersionRecordId: versionRecordId,
      type: "classified_failure",
      evidence: { error: "test error" }
    });

    const curator = new SkillCurator(
      database,
      {},
      undefined,
      notifier
    );

    const candidates = curator.processIncidentsIntoCandidates();
    expect(sentMessages.length).toBeGreaterThan(0);
    expect(sentMessages[0]).toContain("Nova proposta de self-correction");

    curator.evaluateCandidate(candidates[0].id);
    expect(sentMessages.length).toBeGreaterThan(1);
    expect(sentMessages[1]).toContain("Candidato ativado");
  });
});

function setupSkillWithActiveVersion(
  root: string,
  database: MaestroDatabase,
  store: SkillVersionStore,
  name: string,
  owner: "agent" | "user" | "system",
  risk: "low" | "medium" | "high"
) {
  const sourceRoot = path.join(root, "skills-" + name);
  const skillPath = path.join(sourceRoot, name);
  fs.mkdirSync(skillPath, { recursive: true });
  fs.mkdirSync(path.join(skillPath, "evals"), { recursive: true });

  fs.writeFileSync(
    path.join(skillPath, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} test skill.\n---\n\nProcedure body.\n`
  );
  fs.writeFileSync(
    path.join(skillPath, "maestro.yaml"),
    [
      "schemaVersion: 1",
      `owner: ${owner}`,
      `risk: ${risk}`,
      "allowImplicitInvocation: false",
      "capabilities: [coding]",
      `operatingSystems: [${process.platform}]`,
      "network: none",
      "readScopes: ['src']",
      "writeScopes: []",
      "maxRuntimeMs: 30000",
      "maxOutputChars: 8000"
    ].join("\n")
  );

  fs.writeFileSync(
    path.join(skillPath, "evals", "cases.yaml"),
    [
      "schemaVersion: 1",
      "cases:",
      "  - id: check-trigger",
      "    type: trigger",
      `    prompt: test ${name}`,
      "    phase: implementing",
      "    capability: coding",
      "    expectMatch: true",
      "  - id: check-content",
      "    type: content",
      "    requiredPhrases: ['Procedure body']",
      "    forbiddenPhrases: []"
    ].join("\n")
  );

  const snapshot = new SkillCatalog([{ scope: "repository", path: sourceRoot }]).discover();
  expect(snapshot.issues).toEqual([]);
  const metadata = snapshot.skills[0]!;
  const registered = store.register(metadata);

  database.recordSkillEvaluation({
    skillVersionRecordId: registered.id,
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

  database.updateSkillVersionStatus(registered.id, "evaluated");
  database.updateSkillVersionStatus(registered.id, "approved");
  const active = database.activateSkillVersion(registered.id);

  const task = database.createTask(`Task for ${name}`);
  const run = database.createGoalRun(task.id);

  database.pinGoalSkill({
    runId: run.id,
    skillVersionRecordId: active.id,
    triggerReason: "Pinned for testing",
    invocationMode: "explicit"
  });

  const skill = database.getSkillByQualifiedName(`repository:${name}`);

  return {
    skillId: skill.id,
    versionId: active.versionId,
    versionRecordId: active.id,
    runId: run.id
  };
}
