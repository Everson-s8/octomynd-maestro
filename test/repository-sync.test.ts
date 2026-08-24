import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type MaestroDatabase } from "../src/db.js";
import { ApplicationCommands } from "../src/commands/application-commands.js";
import { cloneGitRepository, runGit } from "../src/git.js";
import { ProjectRepositoryService, RepositorySyncError } from "../src/projects/repository-service.js";
import { OperationalChatService } from "../src/chat/service.js";

let tempDir: string;
let database: MaestroDatabase;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-repository-sync-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("project repository synchronization", () => {
  it("imports a repository, bases a task on the latest remote SHA, and recovers on repeat", async () => {
    const seed = createRepository(path.join(tempDir, "seed"));
    const remote = path.join(tempDir, "remote.git");
    runGit(["clone", "--bare", seed, remote], tempDir);
    const remoteUrl = `file://${remote.replace(/\\/g, "/")}`;
    const canonicalPath = path.join(tempDir, "canonical");
    expect(cloneGitRepository(remoteUrl, canonicalPath, "main").ok).toBe(true);

    const project = database.registerProject({ key: "demo", path: canonicalPath, defaultBranch: "main" });
    const service = new ProjectRepositoryService(database);
    const first = service.synchronize(project);
    expect(first.syncState).toBe("current");
    const firstSha = first.canonicalHeadSha;
    expect(firstSha).toMatch(/^[a-f0-9]{40}$/);

    const secondSha = addCommit(seed, "remote change", "remote.txt", "from remote\n", remoteUrl);
    const task = database.createTask("use the latest repository state", "test", "demo");
    const prepared = new ApplicationCommands(database).prepareTask(
      { channel: "maestro" },
      task.id,
      path.join(tempDir, "worktrees")
    );

    expect(prepared.task.baseCommitSha).toBe(secondSha);
    expect(runGit(["rev-parse", "HEAD"], prepared.worktreePath).stdout.trim()).toBe(secondSha);
    expect(database.getProjectByKey("demo").canonicalHeadSha).toBe(secondSha);
    expect(database.getProjectByKey("demo").remoteHeadSha).toBe(secondSha);
    expect(database.getProjectByKey("demo").canonicalHeadSha).not.toBe(firstSha);

    const thirdSha = addCommit(seed, "external merge", "external.txt", "merged remotely\n", remoteUrl);
    const chatEvidence = await new OperationalChatService({ database, repositoryService: service }).gatherEvidenceContext("demo");
    expect(chatEvidence.repositoryState?.canonicalHeadSha).toBe(thirdSha);
    expect(chatEvidence.project.canonicalHeadSha).toBe(thirdSha);

    const nextTask = database.createTask("start after external merge", "maestro", "demo");
    const nextPrepared = new ApplicationCommands(database).prepareTask(
      { channel: "maestro" },
      nextTask.id,
      path.join(tempDir, "worktrees")
    );
    expect(nextPrepared.task.baseCommitSha).toBe(thirdSha);
    expect(runGit(["rev-parse", "HEAD"], nextPrepared.worktreePath).stdout.trim()).toBe(thirdSha);

    const recovered = service.reconcileAfterMerge(database.getProjectByKey("demo"));
    expect(recovered.syncState).toBe("current");
    expect(service.reconcileAfterMerge(database.getProjectByKey("demo")).canonicalHeadSha).toBe(thirdSha);
  }, 30_000);

  it("does not discard dirty or diverged canonical state", () => {
    const seed = createRepository(path.join(tempDir, "seed-dirty"));
    const remote = path.join(tempDir, "remote-dirty.git");
    runGit(["clone", "--bare", seed, remote], tempDir);
    const remoteUrl = `file://${remote.replace(/\\/g, "/")}`;
    const canonicalPath = path.join(tempDir, "canonical-dirty");
    expect(cloneGitRepository(remoteUrl, canonicalPath, "main").ok).toBe(true);
    const project = database.registerProject({ key: "dirty", path: canonicalPath, defaultBranch: "main" });
    const service = new ProjectRepositoryService(database);

    fs.writeFileSync(path.join(canonicalPath, "uncommitted.txt"), "keep me\n");
    expect(() => service.prepareTaskBase(project)).toThrow(RepositorySyncError);
    expect(database.getProjectByKey("dirty").syncState).toBe("dirty");
    expect(fs.existsSync(path.join(canonicalPath, "uncommitted.txt"))).toBe(true);
  }, 30_000);

  it("reports divergence instead of choosing a side silently", () => {
    const seed = createRepository(path.join(tempDir, "seed-diverged"));
    const remote = path.join(tempDir, "remote-diverged.git");
    runGit(["clone", "--bare", seed, remote], tempDir);
    const remoteUrl = `file://${remote.replace(/\\/g, "/")}`;
    const canonicalPath = path.join(tempDir, "canonical-diverged");
    expect(cloneGitRepository(remoteUrl, canonicalPath, "main").ok).toBe(true);
    const project = database.registerProject({ key: "diverged", path: canonicalPath, defaultBranch: "main" });
    const service = new ProjectRepositoryService(database);

    fs.writeFileSync(path.join(canonicalPath, "local.txt"), "local\n");
    expect(runGit(["add", "local.txt"], canonicalPath).ok).toBe(true);
    expect(commit(canonicalPath, "local divergence").ok).toBe(true);
    addCommit(seed, "remote divergence", "remote.txt", "remote\n", remoteUrl);

    expect(() => service.prepareTaskBase(project)).toThrow(RepositorySyncError);
    expect(database.getProjectByKey("diverged").syncState).toBe("diverged");
    expect(fs.existsSync(path.join(canonicalPath, "local.txt"))).toBe(true);
  }, 30_000);
});

function createRepository(repoPath: string): string {
  fs.mkdirSync(repoPath, { recursive: true });
  expect(runGit(["init", "-b", "main"], repoPath).ok).toBe(true);
  fs.writeFileSync(path.join(repoPath, "README.md"), "seed\n");
  expect(runGit(["add", "README.md"], repoPath).ok).toBe(true);
  expect(commit(repoPath, "initial").ok).toBe(true);
  return repoPath;
}

function addCommit(repoPath: string, message: string, file: string, contents: string, remoteUrl: string): string {
  fs.writeFileSync(path.join(repoPath, file), contents);
  expect(runGit(["add", file], repoPath).ok).toBe(true);
  expect(commit(repoPath, message).ok).toBe(true);
  if (!runGit(["remote", "get-url", "origin"], repoPath).ok) {
    expect(runGit(["remote", "add", "origin", remoteUrl], repoPath).ok).toBe(true);
  }
  expect(runGit(["push", "origin", "main"], repoPath).ok).toBe(true);
  return runGit(["rev-parse", "HEAD"], repoPath).stdout.trim();
}

function commit(repoPath: string, message: string) {
  return runGit([
    "-c", "user.name=Repository Test",
    "-c", "user.email=repository-test@octomynd.local",
    "commit", "-m", message
  ], repoPath);
}
