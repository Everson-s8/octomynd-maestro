import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ProjectRecord, TaskRecord } from "./db.js";

export type WorktreePlan = {
  branchName: string;
  worktreePath: string;
  baseRef?: string;
  baseBranch?: string;
};

export type GitCommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export function createWorktreePlan(
  project: ProjectRecord,
  task: TaskRecord,
  worktreesRoot: string,
  base?: { baseRef: string; baseBranch: string }
): WorktreePlan {
  return {
    branchName: `maestro/task-${task.id}-${slugify(task.title || task.text)}`,
    worktreePath: path.join(worktreesRoot, project.key, `task-${task.id}`),
    ...(base ?? {})
  };
}

export function validateGitProject(project: ProjectRecord): string[] {
  const errors: string[] = [];

  if (!fs.existsSync(project.path)) {
    errors.push(`Project path does not exist: ${project.path}`);
    return errors;
  }

  if (!fs.existsSync(path.join(project.path, ".git"))) {
    errors.push(`Project is not a Git repository: ${project.path}`);
  }

  const status = runGit(["status", "--porcelain"], project.path);
  if (!status.ok) {
    errors.push(`Cannot read Git status: ${status.stderr || status.stdout}`);
  } else if (status.stdout.trim()) {
    errors.push("Project Git working tree is dirty. Commit, stash or clean it before preparing a Maestro task.");
  }

  return errors;
}

export function createGitWorktree(project: ProjectRecord, plan: WorktreePlan): GitCommandResult {
  fs.mkdirSync(path.dirname(plan.worktreePath), { recursive: true });

  if (fs.existsSync(plan.worktreePath)) {
    return {
      ok: false,
      stdout: "",
      stderr: `Worktree path already exists: ${plan.worktreePath}`,
      exitCode: 1
    };
  }

  return runGit([
    "worktree",
    "add",
    "-b",
    plan.branchName,
    plan.worktreePath,
    plan.baseRef ?? project.defaultBranch
  ], project.path);
}

export function runGit(args: string[], cwd: string): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });

  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status
  };
}

export function cloneGitRepository(
  remoteUrl: string,
  targetPath: string,
  defaultBranch?: string
): GitCommandResult {
  const urlError = validateRemoteUrl(remoteUrl);
  if (urlError) {
    return { ok: false, stdout: "", stderr: urlError, exitCode: 1 };
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const targetExisted = fs.existsSync(targetPath);

  const args = ["clone"];
  if (defaultBranch && defaultBranch.trim()) {
    args.push("-b", defaultBranch.trim());
  }
  // `--` stops git from parsing a user-controlled value (e.g. one starting with
  // `-`) as an option, closing the git argument-injection class. Scheme is also
  // allow-listed above so only https/git/ssh URLs are accepted.
  args.push("--", remoteUrl.trim(), targetPath);

  const result = runGit(args, path.dirname(targetPath));
  if (
    result.ok ||
    !defaultBranch?.trim() ||
    targetExisted ||
    !/remote branch .* not found|couldn't find remote ref/i.test(`${result.stderr}\n${result.stdout}`)
  ) {
    return result;
  }

  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
    return result;
  }
  return runGit(["clone", "--", remoteUrl.trim(), targetPath], path.dirname(targetPath));
}

export function ensureGitRemoteOrigin(
  repoPath: string,
  remoteUrl: string
): { added: boolean; existingUrl?: string; error?: string } {
  const urlError = validateRemoteUrl(remoteUrl);
  if (urlError) {
    return { added: false, error: urlError };
  }

  const check = runGit(["remote", "get-url", "origin"], repoPath);
  if (check.ok) {
    return { added: false, existingUrl: check.stdout.trim() };
  }

  const add = runGit(["remote", "add", "origin", "--", remoteUrl.trim()], repoPath);
  if (!add.ok) {
    return { added: false, error: add.stderr || add.stdout };
  }

  return { added: true };
}

/**
 * Validate a remote repository URL before it is passed to git. Only allow
 * https, git and ssh schemes so a user-controlled value can never be parsed by
 * git as an option (e.g. `--upload-pack=...`). Returns an error message, or
 * null when the URL is acceptable.
 */
export function validateRemoteUrl(remoteUrl: string): string | null {
  const value = (remoteUrl || "").trim();
  if (!value) return "Remote repository URL is required.";
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (!["https", "git", "ssh", "file"].includes(scheme)) {
      return `Unsupported remote URL scheme "${scheme}". Allowed: https, git, ssh, file.`;
    }
  } else {
    // scp-like syntax (git@host:org/repo) or a plain path — reject to be safe.
    return "Remote URL must use http(s), git, ssh or file scheme.";
  }
  return null;
}

export function detectGitDefaultBranch(repoPath: string): string | null {
  const originHead = runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoPath);
  if (originHead.ok && originHead.stdout.trim()) {
    return originHead.stdout.trim().replace(/^origin\//, "");
  }

  const currentHead = runGit(["symbolic-ref", "--short", "HEAD"], repoPath);
  if (currentHead.ok && currentHead.stdout.trim()) {
    return currentHead.stdout.trim();
  }

  const showCurrent = runGit(["branch", "--show-current"], repoPath);
  if (showCurrent.ok && showCurrent.stdout.trim()) {
    return showCurrent.stdout.trim();
  }

  return null;
}

/**
 * True when the repository has at least one commit. On a freshly created
 * repository HEAD points at an unborn branch, so any operation that needs a
 * base ref (e.g. `git worktree add ... main`) fails with
 * "fatal: invalid reference". Callers should bootstrap first.
 */
export function hasAnyCommit(repoPath: string): boolean {
  return runGit(["rev-parse", "--verify", "--quiet", "HEAD"], repoPath).ok;
}

export type RepositoryBootstrapResult = {
  ok: boolean;
  /** True when this call created the initial commit. */
  bootstrapped: boolean;
  /** True when the initial state was pushed to `origin`. */
  pushed: boolean;
  error?: string;
};

const BOOTSTRAP_GIT_IDENTITY = [
  "-c",
  "user.name=Maestro",
  "-c",
  "user.email=maestro@octomynd.local"
];

const BOOTSTRAP_GITIGNORE = [
  "# Dependencies",
  "node_modules/",
  "",
  "# Build output",
  "dist/",
  "build/",
  "*.tsbuildinfo",
  "",
  "# Environment & secrets",
  ".env",
  ".env.*",
  "",
  "# OS noise",
  ".DS_Store",
  "Thumbs.db",
  ""
].join("\n");

/**
 * Make an empty (zero-commit) repository usable by Maestro: create a minimal
 * README + .gitignore, commit them, and (when a remote exists) publish the
 * branch so remote worktrees/PRs work. Refuses to touch repositories that
 * already have commits or carry uncommitted changes.
 */
export function bootstrapEmptyRepository(
  repoPath: string,
  projectKey: string,
  options: { push?: boolean } = {}
): RepositoryBootstrapResult {
  const fail = (error: string): RepositoryBootstrapResult => ({ ok: false, bootstrapped: false, pushed: false, error });

  if (!fs.existsSync(path.join(repoPath, ".git"))) {
    return fail(`Not a Git repository: ${repoPath}`);
  }
  const status = runGit(["status", "--porcelain"], repoPath);
  if (!status.ok) {
    return fail(status.stderr || status.stdout || "Cannot read Git status.");
  }
  if (hasAnyCommit(repoPath)) {
    return { ok: true, bootstrapped: false, pushed: false };
  }
  // Includes untracked files — a dirty first-commit attempt would mix user
  // data into the scaffolded commit.
  if (status.stdout.trim()) {
    return fail("Repository has uncommitted changes; commit or clean them before Maestro creates the initial commit.");
  }

  try {
    fs.writeFileSync(path.join(repoPath, "README.md"), `# ${projectKey}\n\nScaffolded by Maestro.\n`, "utf8");
    fs.writeFileSync(path.join(repoPath, ".gitignore"), BOOTSTRAP_GITIGNORE, "utf8");
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to write scaffold files.");
  }

  runGit(["add", "README.md", ".gitignore"], repoPath);
  const commit = runGit(
    [...BOOTSTRAP_GIT_IDENTITY, "commit", "-m", "chore: initial commit by Maestro"],
    repoPath
  );
  if (!commit.ok) {
    return fail(commit.stderr || commit.stdout || "git commit failed during bootstrap.");
  }

  let pushed = false;
  if (options.push !== false) {
    const remote = runGit(["remote", "get-url", "origin"], repoPath);
    if (remote.ok) {
      const branch = detectGitDefaultBranch(repoPath) ?? "main";
      // Non-fatal: credentials may be absent; local preparation still works.
      pushed = runGit(["push", "-u", "origin", branch], repoPath).ok;
    }
  }
  return { ok: true, bootstrapped: true, pushed };
}

function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");

  return slug || "task";
}
