import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapEmptyRepository,
  cloneGitRepository,
  createWorktreePlan,
  detectGitDefaultBranch,
  ensureGitRemoteOrigin,
  hasAnyCommit,
  runGit,
  validateGitProject
} from "../src/git.js";
import { ProjectRecord, TaskRecord } from "../src/db.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-git-test-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("git helpers", () => {
  it("creates a deterministic worktree plan", () => {
    const project: ProjectRecord = {
      id: 1,
      key: "octomynd",
      name: "Octomynd",
      path: tempDir,
      defaultBranch: "main",
      createdAt: "now",
      updatedAt: "now"
    };
    const task: TaskRecord = {
      id: 7,
      projectId: 1,
      projectKey: "octomynd",
      projectName: "Octomynd",
      text: "melhorar resposta fora de contexto",
      status: "queued",
      source: "telegram",
      branchName: null,
      worktreePath: null,
      createdAt: "now",
      updatedAt: "now"
    };

    const plan = createWorktreePlan(project, task, path.join(tempDir, "worktrees"));

    expect(plan.branchName).toBe("maestro/task-7-melhorar-resposta-fora-de-contexto");
    expect(plan.worktreePath).toContain(path.join("worktrees", "octomynd", "task-7"));
  });

  it("rejects a non-git project", () => {
    const project: ProjectRecord = {
      id: 1,
      key: "octomynd",
      name: "Octomynd",
      path: tempDir,
      defaultBranch: "main",
      createdAt: "now",
      updatedAt: "now"
    };

    expect(validateGitProject(project)).toContain(`Project is not a Git repository: ${tempDir}`);
  });

  it("clones a git repository into a destination directory", () => {
    const sourceDir = path.join(tempDir, "source-repo");
    fs.mkdirSync(sourceDir);
    runGit(["init", "-b", "main"], sourceDir);
    fs.writeFileSync(path.join(sourceDir, "file.txt"), "hello\n");
    runGit(["add", "file.txt"], sourceDir);
    runGit(["-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "init"], sourceDir);

    const cloneTarget = path.join(tempDir, "cloned-repo");
    const sourceUrl = "file://" + sourceDir.replace(/\\/g, "/");
    const result = cloneGitRepository(sourceUrl, cloneTarget);

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(cloneTarget, "file.txt"))).toBe(true);
  });

  it("falls back to the remote default branch when the configured branch is missing", () => {
    const sourceDir = path.join(tempDir, "develop-repo");
    fs.mkdirSync(sourceDir);
    runGit(["init", "-b", "develop"], sourceDir);
    fs.writeFileSync(path.join(sourceDir, "branch.txt"), "develop\n");
    runGit(["add", "branch.txt"], sourceDir);
    runGit(["-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "init"], sourceDir);

    const cloneTarget = path.join(tempDir, "fallback-clone");
    const sourceUrl = "file://" + sourceDir.replace(/\\/g, "/");
    const result = cloneGitRepository(sourceUrl, cloneTarget, "main");

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(cloneTarget, "branch.txt"), "utf8").trim()).toBe("develop");
    expect(detectGitDefaultBranch(cloneTarget)).toBe("develop");
  });

  it("adds origin remote to a local repo without origin, and detects existing origin", () => {
    const repoDir = path.join(tempDir, "local-repo");
    fs.mkdirSync(repoDir);
    runGit(["init", "-b", "main"], repoDir);

    const first = ensureGitRemoteOrigin(repoDir, "https://github.com/octomynd/test.git");
    expect(first.added).toBe(true);

    const second = ensureGitRemoteOrigin(repoDir, "https://github.com/octomynd/another.git");
    expect(second.added).toBe(false);
    expect(second.existingUrl).toBe("https://github.com/octomynd/test.git");
  });

  it("detects the default branch of a git repository", () => {
    const repoDir = path.join(tempDir, "branch-repo");
    fs.mkdirSync(repoDir);
    runGit(["init", "-b", "develop"], repoDir);
    fs.writeFileSync(path.join(repoDir, "file.txt"), "content\n");
    runGit(["add", "file.txt"], repoDir);
    runGit(["-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "init"], repoDir);

    const branch = detectGitDefaultBranch(repoDir);
    expect(branch).toBe("develop");
  });
});

describe("empty repository bootstrap", () => {
  it("detects a repository with zero commits", () => {
    const repoDir = path.join(tempDir, "empty-repo");
    fs.mkdirSync(repoDir);
    runGit(["init", "-b", "main"], repoDir);

    expect(hasAnyCommit(repoDir)).toBe(false);
  });

  it("detects a repository with commits", () => {
    const repoDir = path.join(tempDir, "committed-repo");
    fs.mkdirSync(repoDir);
    runGit(["init", "-b", "main"], repoDir);
    fs.writeFileSync(path.join(repoDir, "file.txt"), "content\n");
    runGit(["add", "file.txt"], repoDir);
    runGit(["-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "init"], repoDir);

    expect(hasAnyCommit(repoDir)).toBe(true);
  });

  it("bootstraps an empty repository with an initial commit", () => {
    const repoDir = path.join(tempDir, "bootstrap-repo");
    fs.mkdirSync(repoDir);
    runGit(["init", "-b", "main"], repoDir);

    const result = bootstrapEmptyRepository(repoDir, "myfinance");
    expect(result.ok).toBe(true);
    expect(hasAnyCommit(repoDir)).toBe(true);
    expect(fs.existsSync(path.join(repoDir, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(repoDir, ".gitignore"))).toBe(true);
    const log = runGit(["log", "--oneline"], repoDir);
    expect(log.stdout).toMatch(/initial commit by Maestro/i);
  });

  it("does not touch a repository that already has commits", () => {
    const repoDir = path.join(tempDir, "untouched-repo");
    fs.mkdirSync(repoDir);
    runGit(["init", "-b", "main"], repoDir);
    fs.writeFileSync(path.join(repoDir, "file.txt"), "content\n");
    runGit(["add", "file.txt"], repoDir);
    runGit(["-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "init"], repoDir);

    const result = bootstrapEmptyRepository(repoDir, "myfinance");
    expect(result.ok).toBe(true);
    expect(result.bootstrapped).toBe(false);
    const log = runGit(["log", "--oneline"], repoDir);
    expect(log.stdout).not.toMatch(/initial commit by Maestro/i);
  });

  it("refuses to bootstrap a dirty repository", () => {
    const repoDir = path.join(tempDir, "dirty-repo");
    fs.mkdirSync(repoDir);
    runGit(["init", "-b", "main"], repoDir);
    fs.writeFileSync(path.join(repoDir, "uncommitted.txt"), "dirty\n");

    const result = bootstrapEmptyRepository(repoDir, "myfinance");
    expect(result.ok).toBe(false);
    expect(hasAnyCommit(repoDir)).toBe(false);
  });
});
