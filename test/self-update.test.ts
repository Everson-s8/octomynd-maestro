import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, FeatureRecord, MaestroDatabase } from "../src/db.js";
import { SelfUpdateManager, SelfUpdateNotificationEvent } from "../src/runtime/self-update.js";

const PREVIOUS = "1111111111111111111111111111111111111111";
const FEATURE_HEAD = "2222222222222222222222222222222222222222";
const MERGED_MAIN = "3333333333333333333333333333333333333333";

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

function runner(options: { dirty?: boolean; launchOk?: boolean; current?: () => string }) {
  return async (cmd: string, args: string[]) => {
    if (cmd === "git" && args.join(" ") === "rev-parse HEAD") {
      return { ok: true, stdout: `${options.current?.() ?? PREVIOUS}\n`, stderr: "" };
    }
    if (cmd === "git" && args.join(" ") === "rev-parse origin/main") {
      return { ok: true, stdout: `${MERGED_MAIN}\n`, stderr: "" };
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

  it("keeps the updater process outside the stopped runtime descendants", () => {
    const script = fs.readFileSync(path.resolve("scripts/maestro-runtime.ps1"), "utf8");
    expect(script).toContain("Stop-MaestroRuntime -ExcludeProcessIds @($PID)");
    expect(script).toContain("git merge --ff-only origin/main");
  });
});
