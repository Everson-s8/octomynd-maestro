import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { MaestroDatabase, ProjectRecord } from "../db.js";
import { runGit } from "../git.js";

export type RepositorySyncState =
  | "current"
  | "stale"
  | "local_ahead"
  | "diverged"
  | "dirty"
  | "off_default_branch"
  | "local_only"
  | "missing"
  | "broken"
  | "unavailable";

export type RepositoryState = {
  projectKey: string;
  canonicalHeadSha: string | null;
  remoteHeadSha: string | null;
  defaultBranch: string;
  currentBranch: string | null;
  remoteUrl: string | null;
  syncState: RepositorySyncState;
  clean: boolean;
  lastFetchAt: string | null;
  detail: string | null;
};

export type RepositoryBase = {
  baseRef: string;
  baseBranch: string;
  baseCommitSha: string;
  state: RepositoryState;
};

export class RepositorySyncError extends Error {
  constructor(public readonly state: RepositoryState) {
    super(state.detail ?? `Repository @${state.projectKey} cannot be synchronized (${state.syncState}).`);
    this.name = "RepositorySyncError";
  }
}

type RepositoryDatabase = Pick<MaestroDatabase, "updateProjectSyncState">;

const REPOSITORY_GIT_TIMEOUT_MS = 30_000;
const SYNC_LOCK_STALE_MS = 10 * 60_000;

/**
 * Owns the repository boundary used by Dashboard, CLI and task lifecycle.
 * A project base is always an exact commit SHA; branch names are retained only
 * as human-facing metadata and as the canonical branch policy.
 */
export class ProjectRepositoryService {
  constructor(private readonly database?: RepositoryDatabase) {}

  inspect(project: ProjectRecord, fetchRemote = false): RepositoryState {
    const lock = acquireSyncLock(project.path);
    if (!lock) {
      return this.persist(project, this.state(
        project,
        "unavailable",
        project.canonicalHeadSha ?? null,
        project.remoteHeadSha ?? null,
        null,
        false,
        "Another Maestro process is synchronizing this repository. Retry shortly."
      ));
    }
    try {
      return this.inspectUnlocked(project, fetchRemote);
    } finally {
      lock.release();
    }
  }

  private inspectUnlocked(project: ProjectRecord, fetchRemote = false): RepositoryState {
    const projectPath = path.resolve(project.path);
    if (!fs.existsSync(projectPath)) {
      return this.persist(project, this.state(project, "missing", null, null, null, false, `Project path does not exist: ${projectPath}`));
    }
    if (!fs.existsSync(path.join(projectPath, ".git"))) {
      return this.persist(project, this.state(project, "broken", null, null, null, false, `Not a Git repository: ${projectPath}`));
    }

    const branchResult = runGit(["symbolic-ref", "--short", "HEAD"], projectPath);
    const currentBranch = branchResult.ok && branchResult.stdout.trim() ? branchResult.stdout.trim() : null;
    const headResult = runGit(["rev-parse", "--verify", "HEAD"], projectPath);
    const canonicalHeadSha = headResult.ok && headResult.stdout.trim() ? headResult.stdout.trim() : null;
    const remoteResult = runGit(["remote", "get-url", "origin"], projectPath);
    const remoteUrl = remoteResult.ok && remoteResult.stdout.trim() ? remoteResult.stdout.trim() : null;
    const statusResult = runGit(["status", "--porcelain"], projectPath);
    const clean = statusResult.ok && !statusResult.stdout.trim();

    if (!statusResult.ok) {
      return this.persist(project, this.state(project, "broken", canonicalHeadSha, null, currentBranch, false, statusResult.stderr || statusResult.stdout || "Cannot read Git status."));
    }
    if (!canonicalHeadSha) {
      return this.persist(project, this.state(project, remoteUrl ? "unavailable" : "local_only", null, null, currentBranch, clean, "Repository has no commit yet."));
    }
    if (!remoteUrl) {
      return this.persist(project, this.state(project, clean ? "local_only" : "dirty", canonicalHeadSha, null, currentBranch, clean, clean ? "No origin remote is configured." : "Working tree has uncommitted changes."));
    }

    let lastFetchAt = project.lastFetchAt ?? null;
    if (fetchRemote) {
      const fetchedAt = new Date().toISOString();
      let fetchResult = runGit(["fetch", "--prune", "origin", project.defaultBranch], projectPath, {
        timeoutMs: REPOSITORY_GIT_TIMEOUT_MS
      });
      if (!fetchResult.ok) {
        // A freshly bootstrapped repository may have an origin URL but no
        // remote refs yet because the initial push was non-fatal. Confirm that
        // this is truly an empty remote before allowing local-only progress;
        // a network/auth/default-branch failure remains unavailable.
        const remoteHeads = runGit(["ls-remote", "--heads", "origin"], projectPath, {
          timeoutMs: REPOSITORY_GIT_TIMEOUT_MS
        });
        if (!remoteHeads.ok || remoteHeads.stdout.trim()) {
          return this.persist(project, this.state(project, "unavailable", canonicalHeadSha, null, currentBranch, clean, `Could not fetch origin/${project.defaultBranch}: ${fetchResult.stderr || fetchResult.stdout || "unknown error"}`, lastFetchAt));
        }
        fetchResult = runGit(["fetch", "--prune", "origin"], projectPath, {
          timeoutMs: REPOSITORY_GIT_TIMEOUT_MS
        });
        if (!fetchResult.ok) {
          return this.persist(project, this.state(project, "unavailable", canonicalHeadSha, null, currentBranch, clean, `Could not refresh empty origin: ${fetchResult.stderr || fetchResult.stdout || "unknown error"}`, lastFetchAt));
        }
      }
      lastFetchAt = fetchedAt;
    }

    const remoteHeadResult = runGit(["rev-parse", "--verify", `refs/remotes/origin/${project.defaultBranch}`], projectPath);
    const remoteHeadSha = remoteHeadResult.ok && remoteHeadResult.stdout.trim() ? remoteHeadResult.stdout.trim() : null;
    if (!clean) {
      return this.persist(project, this.state(project, "dirty", canonicalHeadSha, remoteHeadSha, currentBranch, false, "Working tree has uncommitted changes.", lastFetchAt));
    }
    if (currentBranch !== project.defaultBranch) {
      return this.persist(project, this.state(project, "off_default_branch", canonicalHeadSha, remoteHeadSha, currentBranch, true, `Canonical checkout is on ${currentBranch ?? "detached HEAD"}; expected ${project.defaultBranch}.`, lastFetchAt));
    }
    if (!remoteHeadSha) {
      return this.persist(project, this.state(project, "local_ahead", canonicalHeadSha, null, currentBranch, true, `Remote branch origin/${project.defaultBranch} is not available yet; the local canonical commit can still be used.`, lastFetchAt));
    }

    const syncState = compareCommits(projectPath, canonicalHeadSha, remoteHeadSha);
    return this.persist(project, this.state(project, syncState, canonicalHeadSha, remoteHeadSha, currentBranch, true, detailFor(syncState), lastFetchAt));
  }

  synchronize(project: ProjectRecord): RepositoryState {
    const lock = acquireSyncLock(project.path);
    if (!lock) {
      const state = this.persist(project, this.state(
        project,
        "unavailable",
        project.canonicalHeadSha ?? null,
        project.remoteHeadSha ?? null,
        null,
        false,
        "Another Maestro process is synchronizing this repository. Retry shortly."
      ));
      throw new RepositorySyncError(state);
    }
    try {
      return this.synchronizeUnlocked(project);
    } finally {
      lock.release();
    }
  }

  private synchronizeUnlocked(project: ProjectRecord): RepositoryState {
    let state = this.inspectUnlocked(project, true);
    if (state.syncState === "stale") {
      const reset = runGit(["merge", "--ff-only", `refs/remotes/origin/${project.defaultBranch}`], project.path);
      if (!reset.ok) {
        state = this.persist(project, { ...state, syncState: "unavailable", detail: reset.stderr || reset.stdout || "Fast-forward synchronization failed." });
      } else {
        state = this.inspectUnlocked({
          ...project,
          canonicalHeadSha: state.canonicalHeadSha,
          remoteHeadSha: state.remoteHeadSha,
          syncState: state.syncState,
          lastFetchAt: state.lastFetchAt
        }, false);
      }
    }
    if (["dirty", "diverged", "off_default_branch", "missing", "broken", "unavailable"].includes(state.syncState)) {
      throw new RepositorySyncError(state);
    }
    return state;
  }

  prepareTaskBase(project: ProjectRecord): RepositoryBase {
    const state = this.synchronize(project);
    if (!state.canonicalHeadSha) throw new RepositorySyncError({ ...state, syncState: "unavailable", detail: "No exact canonical commit is available for task preparation." });
    return {
      baseRef: state.canonicalHeadSha,
      baseBranch: state.defaultBranch,
      baseCommitSha: state.canonicalHeadSha,
      state
    };
  }

  reconcileAfterMerge(project: ProjectRecord): RepositoryState {
    return this.synchronize(project);
  }

  private persist(project: ProjectRecord, state: RepositoryState): RepositoryState {
    if (!this.database) return state;
    try {
      this.database.updateProjectSyncState({
        projectKey: project.key,
        canonicalHeadSha: state.canonicalHeadSha,
        remoteHeadSha: state.remoteHeadSha,
        syncState: state.syncState,
        lastFetchAt: state.lastFetchAt
      });
    } catch {
      // Inspection remains useful for callers/tests even when the project was
      // not registered in the supplied database yet.
    }
    return state;
  }

  private state(
    project: ProjectRecord,
    syncState: RepositorySyncState,
    canonicalHeadSha: string | null,
    remoteHeadSha: string | null,
    currentBranch: string | null,
    clean: boolean,
    detail: string | null,
    lastFetchAt: string | null = project.lastFetchAt ?? null
  ): RepositoryState {
    return {
      projectKey: project.key,
      canonicalHeadSha,
      remoteHeadSha,
      defaultBranch: project.defaultBranch,
      currentBranch,
      remoteUrl: readRemoteUrl(project.path),
      syncState,
      clean,
      lastFetchAt,
      detail
    };
  }
}

function compareCommits(repoPath: string, localSha: string, remoteSha: string): RepositorySyncState {
  if (localSha === remoteSha) return "current";
  if (runGit(["merge-base", "--is-ancestor", localSha, remoteSha], repoPath).ok) return "stale";
  if (runGit(["merge-base", "--is-ancestor", remoteSha, localSha], repoPath).ok) return "local_ahead";
  return "diverged";
}

function detailFor(state: RepositorySyncState): string | null {
  switch (state) {
    case "current": return null;
    case "stale": return "Canonical checkout is behind origin and can be fast-forwarded safely.";
    case "local_ahead": return "Canonical checkout contains local commits not present on origin.";
    case "diverged": return "Canonical checkout and origin have diverged.";
    default: return null;
  }
}

function readRemoteUrl(repoPath: string): string | null {
  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) return null;
  const result = runGit(["remote", "get-url", "origin"], repoPath);
  return result.ok && result.stdout.trim() ? result.stdout.trim() : null;
}

function acquireSyncLock(repoPath: string): { release: () => void } | null {
  const key = crypto.createHash("sha256").update(path.resolve(repoPath)).digest("hex");
  const lockPath = path.join(os.tmpdir(), "maestro-repository-sync", `${key}.lock`);
  const ownerToken = `${process.pid}:${crypto.randomUUID()}`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, "owner"), `${ownerToken}\n${new Date().toISOString()}\n`, "utf8");
      return {
        release: () => {
          try {
            const owner = fs.readFileSync(path.join(lockPath, "owner"), "utf8").split("\n", 1)[0];
            if (owner === ownerToken) fs.rmSync(lockPath, { recursive: true, force: true });
          } catch {
            // The lock was already reclaimed or removed by the owning process.
          }
        }
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") return null;
      try {
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (ageMs > SYNC_LOCK_STALE_MS) {
          const owner = fs.readFileSync(path.join(lockPath, "owner"), "utf8").split("\n", 1)[0];
          const ownerPid = Number(owner.split(":", 1)[0]);
          if (!Number.isInteger(ownerPid) || !isProcessAlive(ownerPid)) {
            fs.rmSync(lockPath, { recursive: true, force: true });
            continue;
          }
        }
      } catch {
        // Another process may be acquiring or releasing the lock. Treat the
        // repository as temporarily unavailable instead of racing it.
      }
      return null;
    }
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
