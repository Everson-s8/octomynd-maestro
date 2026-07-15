import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { ApplicationCommands } from "../src/commands/application-commands.js";
import { ApplicationCommandError } from "../src/commands/errors.js";
import { FeatureGitHubGateway, FeaturePullRequestState } from "../src/features/github.js";

let tempDir: string;
let projectDir: string;
let database: MaestroDatabase;
let commands: ApplicationCommands;
let featureGithub: FakeFeatureGitHubGateway;

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
  featureGithub = new FakeFeatureGitHubGateway();
  commands = new ApplicationCommands(database, featureGithub);
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

  it("accepts the internal Maestro origin used by backlog automation", () => {
    const task = commands.createTask(
      { channel: "maestro" },
      { text: "internal backlog task", projectKey: "boo" }
    );

    expect(task.source).toBe("maestro");
    expect(database.getLastEvent()?.source).toBe("maestro");
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

describe("ApplicationCommands.cancelFeature", () => {
  it("closes the consolidated PR and preserves an audited cancelled record", async () => {
    const feature = database.createFeature({
      projectKey: "boo",
      name: "Feature cancelavel",
      objective: "Cancelar antes do merge.",
      branchName: "maestro/feature-cancelavel",
      worktreePath: path.join(tempDir, "feature-cancelavel"),
      pullRequestUrl: featureGithub.state.url
    });

    const cancelled = await commands.cancelFeature(
      { channel: "telegram", userId: "42", username: "operador" },
      feature.id,
      "Prioridade mudou."
    );

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelReason).toBe("Prioridade mudou.");
    expect(featureGithub.closed).toEqual([featureGithub.state.url]);
    expect(database.getLastEvent()).toMatchObject({
      source: "telegram",
      type: "feature.cancelled",
      userId: "42"
    });
  });

  it("fails closed when GitHub reports that the Feature PR was already merged", async () => {
    featureGithub.state = { ...featureGithub.state, state: "MERGED", isDraft: false };
    const feature = database.createFeature({
      projectKey: "boo",
      name: "Feature mergeada",
      objective: "Nao pode cancelar depois do merge.",
      branchName: "maestro/feature-merged",
      worktreePath: path.join(tempDir, "feature-merged"),
      pullRequestUrl: featureGithub.state.url
    });

    await expect(commands.cancelFeature({ channel: "dashboard" }, feature.id)).rejects.toMatchObject({
      code: "conflict"
    });
    expect(database.getFeature(feature.id).status).toBe("draft");
    expect(featureGithub.closed).toHaveLength(0);
  });

  it("keeps the Feature cancelled when closing GitHub fails and audits the cleanup blocker", async () => {
    const feature = database.createFeature({
      projectKey: "boo",
      name: "Feature com falha de fechamento",
      objective: "Cancelar localmente mesmo se GitHub estiver indisponivel.",
      branchName: "maestro/feature-close-failure",
      worktreePath: path.join(tempDir, "feature-close-failure"),
      pullRequestUrl: featureGithub.state.url
    });
    featureGithub.closeError = new Error(`Falha em C:\\Users\\private com sk-proj-${"x".repeat(48)}`);

    const cancelled = await commands.cancelFeature({ channel: "dashboard" }, feature.id, "Cancelamento seguro.");

    expect(cancelled.status).toBe("cancelled");
    const closeFailure = database.listEvents(10).find((event) => event.type === "feature.cancel_close_failed");
    expect(closeFailure).toBeDefined();
    expect(closeFailure?.text).not.toContain("C:\\Users\\private");
    expect(closeFailure?.text).not.toContain(`sk-proj-${"x".repeat(48)}`);
  });
});

function runGit(args: string[], cwd: string) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "git test setup failed");
  }
}

class FakeFeatureGitHubGateway implements FeatureGitHubGateway {
  state: FeaturePullRequestState = {
    number: 7,
    title: "Feature cancelavel",
    url: "https://github.com/example/boo/pull/7",
    state: "OPEN",
    isDraft: true,
    mergeable: "MERGEABLE",
    headRefName: "maestro/feature-cancelavel",
    headRepositoryOwner: "example",
    headRepositoryName: "boo",
    baseRefName: "master",
    headSha: "a".repeat(40),
    checks: []
  };
  readonly closed: string[] = [];
  closeError: Error | null = null;

  async inspect(): Promise<FeaturePullRequestState> { return { ...this.state, checks: [...this.state.checks] }; }
  async merge(): Promise<void> {}
  async markDraft(): Promise<void> {}
  async close(url: string): Promise<void> {
    if (this.closeError) throw this.closeError;
    this.closed.push(url);
    this.state = { ...this.state, state: "CLOSED" };
  }
  async closeSuperseded(): Promise<void> {}
  async deleteHeadBranch(): Promise<void> {}
  async closeIssue(): Promise<void> {}
}
