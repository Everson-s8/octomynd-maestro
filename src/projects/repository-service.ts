import fs from "node:fs";
import path from "node:path";
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

/**
 * Owns the repository boundary used by Dashboard, CLI and task lifecycle.
 * A project base is always an exact commit SHA; branch names are retained only
 * as human-facing metadata and as the canonical branch policy.
 */
export class ProjectRepositoryService {
  constructor(private readonly database?: RepositoryDatabase) {}

  inspect(project: ProjectRecord, fetchRemote = false): RepositoryState {
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
      const fetchResult = runGit(["fetch", "--prune", "origin", project.defaultBranch], projectPath);
      if (!fetchResult.ok) {
        return this.persist(project, this.state(project, "unavailable", canonicalHeadSha, null, currentBranch, clean, `Could not fetch origin/${project.defaultBranch}: ${fetchResult.stderr || fetchResult.stdout || "unknown error"}`, lastFetchAt));
      }
      lastFetchAt = fetchedAt;
    }

    const remoteHeadResult = runGit(["rev-parse", "--verify", `refs/remotes/origin/${project.defaultBranch}`], projectPath);
    const remoteHeadSha = remoteHeadResult.ok && remoteHeadResult.stdout.trim() ? remoteHeadResult.stdout.trim() : null;
    if (!remoteHeadSha) {
      return this.persist(project, this.state(project, "unavailable", canonicalHeadSha, null, currentBranch, clean, `Remote branch origin/${project.defaultBranch} is unavailable.`, lastFetchAt));
    }
    if (!clean) {
      return this.persist(project, this.state(project, "dirty", canonicalHeadSha, remoteHeadSha, currentBranch, false, "Working tree has uncommitted changes.", lastFetchAt));
    }
    if (currentBranch !== project.defaultBranch) {
      return this.persist(project, this.state(project, "off_default_branch", canonicalHeadSha, remoteHeadSha, currentBranch, true, `Canonical checkout is on ${currentBranch ?? "detached HEAD"}; expected ${project.defaultBranch}.`, lastFetchAt));
    }

    const syncState = compareCommits(projectPath, canonicalHeadSha, remoteHeadSha);
    return this.persist(project, this.state(project, syncState, canonicalHeadSha, remoteHeadSha, currentBranch, true, detailFor(syncState), lastFetchAt));
  }

  synchronize(project: ProjectRecord): RepositoryState {
    let state = this.inspect(project, true);
    if (state.syncState === "stale") {
      const reset = runGit(["merge", "--ff-only", `refs/remotes/origin/${project.defaultBranch}`], project.path);
      if (!reset.ok) {
        state = this.persist(project, { ...state, syncState: "unavailable", detail: reset.stderr || reset.stdout || "Fast-forward synchronization failed." });
      } else {
        state = this.inspect({
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
