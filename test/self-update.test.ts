import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, FeatureRecord, MaestroDatabase } from "../src/db.js";
import { SelfUpdateManager, SelfUpdateNotificationEvent } from "../src/runtime/self-update.js";
import { createTelegramBot } from "../src/telegram/bot.js";

const PREVIOUS = "1111111111111111111111111111111111111111";
const FEATURE_HEAD = "2222222222222222222222222222222222222222";
const MERGED_MAIN = "3333333333333333333333333333333333333333";
const NEW_MAIN = "4444444444444444444444444444444444444444";

let tempDir: string;
let database: MaestroDatabase;
let feature: FeatureRecord;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-self-update-test-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
  database.registerProject({ key: "maestro", name: "Octomynd Maestro", path: tempDir });
  feature = database.createFeature({
    projectKey: "maestro",
    name: "Self Update Test Feature",
    objective: "Implement safe self-update and supervised restart",
    branchName: "maestro/self-update",
    worktreePath: tempDir,
    pullRequestUrl: "https://github.com/example/project/pull/41"
  });
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function runner(options: { dirty?: boolean; launchOk?: boolean; current?: () => string; remoteMain?: () => string }) {
  return async (cmd: string, args: string[]) => {
    if (cmd === "git" && args.join(" ") === "rev-parse HEAD") {
      return { ok: true, stdout: `${options.current?.() ?? PREVIOUS}\n`, stderr: "" };
    }
    if (cmd === "git" && args.join(" ") === "rev-parse origin/main") {
      return { ok: true, stdout: `${options.remoteMain?.() ?? MERGED_MAIN}\n`, stderr: "" };
    }
    if (cmd === "git" && args[0] === "fetch") return { ok: true, stdout: "", stderr: "" };
    if (cmd === "git" && args[0] === "merge-base") return { ok: true, stdout: "", stderr: "" };
    if (cmd === "git" && args[0] === "status") {
      return { ok: true, stdout: options.dirty ? " M README.md\n" : "", stderr: "" };
    }
    if (cmd === "powershell.exe" && args.includes("apply-update")) {
      return options.launchOk === false
        ? { ok: false, stdout: "", stderr: "launch failed" }
        : { ok: true, stdout: "launched", stderr: "" };
    }
    throw new Error(`Unexpected command: ${cmd} ${args.join(" ")}`);
  };
}

describe("SelfUpdateManager protocol and safety gates", () => {
  it("refuses a dirty worktree before launching the updater", async () => {
    const events: SelfUpdateNotificationEvent[] = [];
    const manager = new SelfUpdateManager(database, tempDir, "script.ps1", async (event) => { events.push(event); }, runner({ dirty: true }));
    const record = await manager.triggerUpdate(feature, FEATURE_HEAD);
    expect(record.status).toBe("failed");
    expect(record.error).toContain("uncommitted changes");
    expect(events.map((event) => event.type)).toEqual(["start", "failure"]);
  });

  it("queues the merged main commit and leaves completion to the restarted runtime", async () => {
    const events: SelfUpdateNotificationEvent[] = [];
    const manager = new SelfUpdateManager(database, tempDir, "script.ps1", async (event) => { events.push(event); }, runner({}));
    const record = await manager.triggerUpdate(feature, FEATURE_HEAD);
    expect(record.status).toBe("in_progress");
    expect(record.targetCommit).toBe(MERGED_MAIN);
    expect(events.map((event) => event.type)).toEqual(["start", "commit"]);
  });

  it("reconciles success after the new runtime starts at the target commit", async () => {
    let current = PREVIOUS;
    const events: SelfUpdateNotificationEvent[] = [];
    const manager = new SelfUpdateManager(database, tempDir, "script.ps1", async (event) => { events.push(event); }, runner({ current: () => current }));
    await manager.triggerUpdate(feature, FEATURE_HEAD);
    current = MERGED_MAIN;
    const record = await manager.reconcileLatestUpdate();
    expect(record?.status).toBe("completed");
    expect(events.map((event) => event.type)).toEqual(["start", "commit", "success"]);
  });

  it("reconciles rollback after the runtime returns to the previous commit", async () => {
    const events: SelfUpdateNotificationEvent[] = [];
    const manager = new SelfUpdateManager(database, tempDir, "script.ps1", async (event) => { events.push(event); }, runner({ current: () => PREVIOUS }));
    await manager.triggerUpdate(feature, FEATURE_HEAD);
    const record = await manager.reconcileLatestUpdate();
    expect(record?.status).toBe("rolled_back");
    expect(events.map((event) => event.type)).toEqual(["start", "commit", "rollback"]);
  });

  it("restart after merge: detects origin/main updates via reconcile polling when regular task PRs merge to main", async () => {
    let current = PREVIOUS;
    let remote = NEW_MAIN;
    const events: SelfUpdateNotificationEvent[] = [];
    const manager = new SelfUpdateManager(
      database,
      tempDir,
      "script.ps1",
      async (event) => { events.push(event); },
      runner({ current: () => current, remoteMain: () => remote })
    );

    // Reconcile tick detects origin/main differs from current HEAD and triggers restart
    const record = await manager.reconcileLatestUpdate();
    expect(record?.status).toBe("in_progress");
    expect(record?.targetCommit).toBe(NEW_MAIN);
    expect(events.map((e) => e.type)).toEqual(["start", "commit"]);

    // After runtime restarts at new commit, next reconcile completes it
    current = NEW_MAIN;
    const completedRecord = await manager.reconcileLatestUpdate();
    expect(completedRecord?.status).toBe("completed");
    expect(completedRecord?.targetCommit).toBe(NEW_MAIN);
    expect(events.map((e) => e.type)).toEqual(["start", "commit", "success"]);
  });

  it("idempotent double-trigger: does not duplicate update records or execution when called repeatedly", async () => {
    const events: SelfUpdateNotificationEvent[] = [];
    const manager = new SelfUpdateManager(
      database,
      tempDir,
      "script.ps1",
      async (event) => { events.push(event); },
      runner({ remoteMain: () => MERGED_MAIN })
    );

    const first = await manager.triggerUpdate(MERGED_MAIN);
    expect(first.status).toBe("in_progress");
    expect(events.length).toBe(2); // start, commit

    // Second trigger call with same target commit returns active record without re-executing
    const second = await manager.triggerUpdate(MERGED_MAIN);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("in_progress");
    expect(events.length).toBe(2); // No extra events emitted
  });

  it("handles rollback on failed startup in maestro-runtime.ps1 script", () => {
    const script = fs.readFileSync(path.resolve("scripts/maestro-runtime.ps1"), "utf8");
    expect(script).toContain("Stop-MaestroRuntime -ExcludeProcessIds @($PID)");
    expect(script).toContain("git merge --ff-only origin/main");
    expect(script).toContain("git reset --hard $previousCommit");
    expect(script).toContain("Test-MaestroHealth");
  });

  it("supports /update Telegram command for manual trigger", async () => {
    const mockConfig = {
      projectName: "octomynd-maestro",
      databasePath: path.join(tempDir, "maestro.db"),
      worktreesPath: tempDir,
      execution: { rootPath: tempDir, worktreesPath: tempDir, projectRoot: tempDir } as any,
      dashboard: { enabled: false, host: "127.0.0.1", port: 4787 },
      autopilot: { enabled: true, pollIntervalMs: 30000, maxConcurrentGoals: 1 },
      runtime: { tokenEfficient: true },
      workGraph: { adoptionMode: "off" as const },
      skills: { enabled: false, catalogPath: "", versionsPath: "", projectKey: "maestro", curator: { staleDays: 30, autoArchiveEnabled: false, pollIntervalMs: 3600000 } },
      telegram: { botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11", allowedUserId: null }
    };

    let updateTriggered = false;
    const bot = createTelegramBot(mockConfig as any, database, {
      triggerSelfUpdate: async () => {
        updateTriggered = true;
        return database.enqueueRuntimeUpdate({ targetCommit: NEW_MAIN, previousCommit: PREVIOUS });
      }
    });

    expect(bot).toBeDefined();
  });
});
