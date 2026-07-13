import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { ApplicationCommands } from "../src/commands/application-commands.js";
import { ApplicationCommandError } from "../src/commands/errors.js";

let tempDir: string;
let projectDir: string;
let database: MaestroDatabase;
let commands: ApplicationCommands;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-commands-"));
  projectDir = path.join(tempDir, "boo-project");
  fs.mkdirSync(projectDir);
  runGit(["init", "-b", "master"], projectDir);
  fs.writeFileSync(path.join(projectDir, "README.md"), "# Boo test\n");
  runGit(["add", "README.md"], projectDir);
  runGit(["-c", "user.name=Maestro Test", "-c", "user.email=maestro@test.local", "commit", "-m", "Initial"], projectDir);

  database = createDatabase(path.join(tempDir, "maestro.db"));
  database.registerProject({ key: "boo", name: "Boo", path: projectDir, defaultBranch: "master" });
  commands = new ApplicationCommands(database);
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("ApplicationCommands.createTask", () => {
  it("persists the task with the origin channel as source, regardless of caller", () => {
    const dashboardTask = commands.createTask({ channel: "dashboard" }, { text: "criada pelo dashboard", projectKey: "boo" });
    expect(dashboardTask.source).toBe("dashboard");

    const telegramTask = commands.createTask(
      { channel: "telegram", userId: "42", username: "operador" },
      { text: "criada pelo telegram", projectKey: "boo" }
    );
    expect(telegramTask.source).toBe("telegram");
  });

  it("records an audit event carrying the origin metadata", () => {
    commands.createTask({ channel: "telegram", userId: "42", username: "operador" }, { text: "com auditoria", projectKey: "boo" });

    const event = database.getLastEvent();
    expect(event?.type).toBe("task.created");
    expect(event?.source).toBe("telegram");
    expect(event?.userId).toBe("42");
    expect(event?.username).toBe("operador");
  });

  it("throws a typed validation error for blank text", () => {
    expect(() => commands.createTask({ channel: "dashboard" }, { text: "   ", projectKey: "boo" })).toThrowError(
      ApplicationCommandError
    );
    try {
      commands.createTask({ channel: "dashboard" }, { text: "", projectKey: "boo" });
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationCommandError);
      expect((error as ApplicationCommandError).code).toBe("validation");
    }
  });

  it("throws a typed not_found error for an unknown project", () => {
    expect.assertions(2);
    try {
      commands.createTask({ channel: "dashboard" }, { text: "task orfa", projectKey: "does-not-exist" });
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationCommandError);
      expect((error as ApplicationCommandError).code).toBe("not_found");
    }
  });
});

describe("ApplicationCommands.prepareTask", () => {
  it("prepares a worktree and records an audit event with the origin channel", () => {
    const task = commands.createTask({ channel: "dashboard" }, { text: "preparar worktree", projectKey: "boo" });

    const result = commands.prepareTask({ channel: "dashboard" }, task.id, path.join(tempDir, "worktrees"));

    expect(result.task.status).toBe("planning");
    expect(fs.existsSync(result.worktreePath)).toBe(true);
    const event = database.getLastEvent();
    expect(event?.type).toBe("task.prepared");
    expect(event?.source).toBe("dashboard");
  });

  it("throws a typed not_found error and records no event for an unknown task", () => {
    expect.assertions(3);
    const eventsBefore = database.listEvents().length;
    try {
      commands.prepareTask({ channel: "telegram" }, 999, path.join(tempDir, "worktrees"));
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationCommandError);
      expect((error as ApplicationCommandError).code).toBe("not_found");
    }
    expect(database.listEvents().length).toBe(eventsBefore);
  });

  it("throws a typed conflict error and audits the failure when a worktree already exists", () => {
    expect.assertions(3);
    const task = commands.createTask({ channel: "dashboard" }, { text: "preparar duas vezes", projectKey: "boo" });
    commands.prepareTask({ channel: "dashboard" }, task.id, path.join(tempDir, "worktrees"));

    try {
      commands.prepareTask({ channel: "dashboard" }, task.id, path.join(tempDir, "worktrees"));
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationCommandError);
      expect((error as ApplicationCommandError).code).toBe("conflict");
    }

    const event = database.getLastEvent();
    expect(event?.type).toBe("task.prepare_failed");
  });
});

describe("ApplicationCommands.registerProject", () => {
  it("registers a project and records an audit event", () => {
    const otherProjectDir = path.join(tempDir, "other-project");
    fs.mkdirSync(otherProjectDir);
    runGit(["init", "-b", "main"], otherProjectDir);

    const result = commands.registerProject(
      { channel: "telegram", userId: "42", username: "operador" },
      { key: "other", path: otherProjectDir }
    );

    expect(result.project.key).toBe("other");
    const event = database.getLastEvent();
    expect(event?.type).toBe("project.registered");
    expect(event?.source).toBe("telegram");
  });

  it("throws a typed validation error for a missing path", () => {
    expect.assertions(2);
    try {
      commands.registerProject({ channel: "dashboard" }, { key: "missing", path: path.join(tempDir, "nope") });
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationCommandError);
      expect((error as ApplicationCommandError).code).toBe("validation");
    }
  });
});

function runGit(args: string[], cwd: string) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "git test setup failed");
  }
}
