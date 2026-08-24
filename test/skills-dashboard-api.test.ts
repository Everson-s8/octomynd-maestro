import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MaestroConfig } from "../src/config.js";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { SkillCatalog } from "../src/skills/catalog.js";
import { SkillCurator } from "../src/skills/curator.js";
import { SkillEvaluationHarness } from "../src/skills/evaluation.js";
import { SkillVersionStore } from "../src/skills/store.js";

let tempDir: string;
let database: MaestroDatabase;
let config: MaestroConfig;
let store: SkillVersionStore;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-skill-api-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
  store = new SkillVersionStore(database, path.join(tempDir, "managed-skill-versions"));
  config = {
    projectName: "maestro-test",
    databasePath: path.join(tempDir, "maestro.db"),
    worktreesPath: path.join(tempDir, "worktrees"),
    execution: {
      rootPath: tempDir,
      worktreesPath: path.join(tempDir, "worktrees"),
      expectedNodeVersion: "22.12.0",
      supportedNodeRange: ">=22.12.0 <25"
    },
    dashboard: { enabled: true, host: "127.0.0.1", port: 4787 },
    autopilot: { enabled: true, pollIntervalMs: 30_000, maxConcurrentGoals: 1 },
    runtime: { tokenEfficient: true },
    workGraph: { adoptionMode: "off" },
    skills: {
      enabled: true,
      catalogPath: path.join(tempDir, "skills"),
      versionsPath: path.join(tempDir, "versions"),
      projectKey: "maestro",
      curator: { staleDays: 30, autoArchiveEnabled: false, pollIntervalMs: 21_600_000 }
    },
    telegram: { botToken: "test-token", allowedUserId: "123" }
  };
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Skill lifecycle dashboard API", () => {
  it("always exposes a Curator dry-run report, and lists Skill drafts, without a governed runtime", async () => {
    const server = createDashboardServer({ config, database, staticRoot: tempDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const reportResponse = await fetch(`http://127.0.0.1:${port}/api/skills/curator/report`);
      expect(reportResponse.status).toBe(200);
      const reportBody = await reportResponse.json() as { report: { entries: unknown[] } };
      expect(reportBody.report.entries).toEqual([]);

      const proposalsResponse = await fetch(`http://127.0.0.1:${port}/api/skills/proposals`);
      expect(proposalsResponse.status).toBe(200);
      expect(await proposalsResponse.json()).toEqual({ proposals: [] });

      const applyResponse = await fetch(`http://127.0.0.1:${port}/api/skills/curator/apply`, { method: "POST" });
      expect(applyResponse.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("evaluates, approves, activates and rolls back a Skill version through the governed runtime", async () => {
    const sourceRoot = path.join(tempDir, "skills");
    writeAgentOwnedSkillWithEvals(sourceRoot, "governed-checklist", "Checklist body");
    const metadata = new SkillCatalog([{ scope: "repository", path: sourceRoot }]).discover().skills[0]!;
    const registered = store.register(metadata);
    expect(registered.status).toBe("candidate");

    const skillLifecycle = {
      store,
      harness: new SkillEvaluationHarness(database, store),
      curator: new SkillCurator(database)
    };
    const server = createDashboardServer({ config, database, staticRoot: tempDir, skillLifecycle });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/skills/versions/${registered.id}`;

    try {
      const evaluateResponse = await fetch(`${base}/evaluate`, { method: "POST" });
      expect(evaluateResponse.status).toBe(200);
      const evaluated = (await evaluateResponse.json()).result as { status: string };
      expect(evaluated.status).toBe("passed");
      expect(database.getSkillVersion(registered.id).status).toBe("evaluated");

      const approveResponse = await fetch(`${base}/approve`, { method: "POST" });
      expect(approveResponse.status).toBe(200);
      expect(database.getSkillVersion(registered.id).status).toBe("approved");

      const activateResponse = await fetch(`${base}/activate`, { method: "POST" });
      expect(activateResponse.status).toBe(200);
      const activated = (await activateResponse.json()).result as { status: string };
      expect(activated.status).toBe("active");

      const rollbackResponse = await fetch(`${base}/rollback`, { method: "POST" });
      expect(rollbackResponse.status).toBe(409);

      expect(database.listEvents().map((event) => event.type)).toEqual(expect.arrayContaining([
        "skill.version_evaluated",
        "skill.version_approved",
        "skill.version_activated"
      ]));
    } finally {
      server.close();
    }
  });
});

function writeAgentOwnedSkillWithEvals(root: string, name: string, body: string): void {
  const skillPath = path.join(root, name);
  fs.mkdirSync(path.join(skillPath, "evals"), { recursive: true });
  fs.writeFileSync(path.join(skillPath, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${name} procedure. Use only after explicit selection.`,
    "---",
    "",
    body,
    ""
  ].join("\n"));
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
  fs.writeFileSync(path.join(skillPath, "evals", "cases.yaml"), [
    "schemaVersion: 1",
    "cases:",
    "  - id: trigger-positive",
    "    type: trigger",
    "    prompt: use the governed checklist",
    "    phase: implementing",
    "    capability: coding",
    "    expectMatch: true",
    "  - id: content-check",
    "    type: content",
    "    requiredPhrases: ['Checklist body']",
    "    forbiddenPhrases: []"
  ].join("\n"));
}
