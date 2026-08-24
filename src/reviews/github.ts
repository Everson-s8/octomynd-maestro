import { spawnSync } from "node:child_process";

export type PullRequestState = { isDraft: boolean; state: "OPEN" | "CLOSED" | "MERGED" };

export interface ReviewGitHubGateway {
  inspect(url: string): Promise<PullRequestState>;
  markReady(url: string): Promise<void>;
  merge?(url: string): Promise<void>;
  markDraft(url: string): Promise<void>;
  close(url: string): Promise<void>;
}

export class GhReviewGateway implements ReviewGitHubGateway {
  async inspect(url: string): Promise<PullRequestState> {
    return readState(url);
  }

  async markReady(url: string): Promise<void> {
    const state = readState(url);
    if (state.state !== "OPEN") throw new Error("Pull request is not open.");
    if (!state.isDraft) return;
    requireGh(["pr", "ready", url], "mark pull request ready for merge");
  }

  async merge(url: string): Promise<void> {
    const state = readState(url);
    if (state.state === "MERGED") return;
    if (state.state === "CLOSED") throw new Error("Closed pull requests cannot be merged.");
    if (state.isDraft) await this.markReady(url);
    requireGh(["pr", "merge", url, "--merge", "--delete-branch"], "merge approved pull request");
  }

  async markDraft(url: string): Promise<void> {
    const state = readState(url);
    if (state.state !== "OPEN" || state.isDraft) return;
    requireGh(["pr", "ready", "--undo", url], "return pull request to draft");
  }

  async close(url: string): Promise<void> {
    const state = readState(url);
    if (state.state === "CLOSED") return;
    if (state.state === "MERGED") throw new Error("Merged pull requests cannot be rejected.");
    requireGh(["pr", "close", url], "close rejected pull request");
  }
}

function readState(url: string): PullRequestState {
  const output = requireGh(
    ["pr", "view", url, "--json", "isDraft,state"],
    "inspect pull request state"
  );
  const parsed = JSON.parse(output) as PullRequestState;
  return parsed;
}

function requireGh(args: string[], operation: string): string {
  const result = spawnSync("gh", args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`Cannot ${operation}: ${(result.stderr || result.stdout || "unknown GitHub error").trim()}`);
  }
  return result.stdout.trim();
}
