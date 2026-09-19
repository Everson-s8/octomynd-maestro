import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../src/db.js";
import { AgentRegistry } from "../src/agents/registry.js";
import type { AgentProvider } from "../src/agents/types.js";
import { OperationalChatService } from "../src/chat/service.js";
import { executeChatCommand, planChatCommand } from "../src/chat/project-command.js";
import { runGit } from "../src/git.js";

describe("chat command execution", () => {
  let tmpDir: string | undefined;
  let database: ReturnType<typeof createDatabase> | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("plans only explicit safe commands and blocks shell or mutating commands", () => {
    expect(planChatCommand("rode os testes")).toEqual(expect.objectContaining({
      executable: expect.stringMatching(/npm(?:\.cmd)?$/),
      args: ["test"]
    }));
    expect(planChatCommand("npm run typecheck")).toEqual(expect.objectContaining({
      args: ["run", "typecheck"]
    }));
    expect(planChatCommand("npm install")).toEqual(expect.objectContaining({
      blockedReason: expect.stringContaining("Dependency installation")
    }));
    expect(planChatCommand("git status; type C:\\secrets.txt")).toEqual(expect.objectContaining({
      blockedReason: expect.stringContaining("Shell operators")
    }));
  });

  it("gives the same command different outcomes at each access level", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-chat-access-"));
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "access-test", version: "1.0.0" }), "utf8");

    const standard = planChatCommand("npm install");
    expect(standard?.blockedReason).toContain("Approval or Full Access");

    const approval = planChatCommand("npm install", "approval");
    expect(approval?.blockedReason).toBeUndefined();
    expect(approval?.standardAllowed).toBe(false);
    expect((await executeChatCommand(approval!, tmpDir, "approval")).status).toBe("pending");

    const full = planChatCommand("npm install --ignore-scripts --no-audit --no-fund", "full");
    expect(full?.blockedReason).toBeUndefined();
    expect((await executeChatCommand(full!, tmpDir, "full")).status).toBe("completed");

    const readOnly = planChatCommand("npm install");
    expect((await executeChatCommand(readOnly!, tmpDir, "read_only")).status).toBe("blocked");
  });

  it("executes a real project command and reports a non-zero command honestly", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-chat-command-"));
    expect(runGit(["init", "-b", "main"], tmpDir).ok).toBe(true);
    fs.writeFileSync(path.join(tmpDir, "untracked.txt"), "visible status\n", "utf8");

    const plan = planChatCommand("git status --short");
    expect(plan?.blockedReason).toBeUndefined();
    const completed = await executeChatCommand(plan!, tmpDir, "standard");
    expect(completed.status).toBe("completed");
    expect(completed.stdout).toContain("untracked.txt");

    const failed = await executeChatCommand(planChatCommand("git status --short")!, path.join(tmpDir, "missing"), "standard");
    expect(failed.status).toBe("failed");
    expect(failed.detail ?? failed.stderr).toBeTruthy();

    const readOnly = await executeChatCommand(plan!, tmpDir, "read_only");
    expect(readOnly.status).toBe("blocked");
    expect(readOnly.detail).toContain("read-only");
  });

  it("shows command evidence in the operational chat response", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-chat-command-service-"));
    expect(runGit(["init", "-b", "main"], tmpDir).ok).toBe(true);
    fs.writeFileSync(path.join(tmpDir, "chat-command-proof.txt"), "proof\n", "utf8");
    database = createDatabase(path.join(tmpDir, "maestro.db"));
    database.registerProject({ key: "demo", name: "Demo", path: tmpDir, defaultBranch: "main" });
    const provider: AgentProvider = {
      id: "claude",
      label: "Claude",
      capabilities: new Set(["conversation"]),
      health: async () => ({ state: "ready", detail: "ready", checkedAt: new Date().toISOString() }),
      models: async () => [],
      execute: async () => ({
        outcome: "completed",
        summary: "answered",
        output: "I checked the command result.",
        error: null,
        durationMs: 1,
        retryable: false
      })
    };
    const service = new OperationalChatService({
      database,
      agentRegistry: new AgentRegistry([provider]),
      worktreesRoot: tmpDir
    });

    const response = await service.ask({
      projectKey: "demo",
      surface: "dashboard",
      accessMode: "standard",
      message: "git status --short"
    });

    expect(response.evidence.commands).toHaveLength(1);
    expect(response.evidence.commands[0]).toEqual(expect.objectContaining({ status: "completed" }));
    expect(response.explanation).toContain("chat-command-proof.txt");
    expect(response.explanation).toContain("Actual command result");
  });
});
