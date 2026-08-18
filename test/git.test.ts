import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cloneGitRepository,
  createWorktreePlan,
  detectGitDefaultBranch,
  ensureGitRemoteOrigin,
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
    const result = cloneGitRepository(sourceDir, cloneTarget);

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(cloneTarget, "file.txt"))).toBe(true);
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
