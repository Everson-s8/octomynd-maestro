import { execFile } from "node:child_process";
import { redactSensitiveText } from "../security/redaction.js";

export type FeatureCheck = {
  name: string;
  status: string;
  conclusion: string;
};

export type FeaturePullRequestState = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  headRefName: string;
  headRepositoryOwner: string;
  headRepositoryName: string;
  baseRefName: string;
  headSha: string;
  checks: FeatureCheck[];
};

export interface FeatureGitHubGateway {
  inspect(url: string): Promise<FeaturePullRequestState>;
  merge(url: string, expectedHeadSha: string): Promise<void>;
  markDraft(url: string): Promise<void>;
  close(url: string, comment: string): Promise<void>;
  closeSuperseded(url: string, featureUrl: string): Promise<void>;
  deleteHeadBranch(url: string): Promise<void>;
  closeIssue(url: string, issueNumber: number, comment: string): Promise<void>;
}

export class GhFeatureGateway implements FeatureGitHubGateway {
  async inspect(url: string): Promise<FeaturePullRequestState> {
    const output = await runGh([
      "pr",
      "view",
      url,
      "--json",
      "number,title,url,state,isDraft,mergeable,headRefName,headRepository,headRepositoryOwner,baseRefName,headRefOid,statusCheckRollup"
    ], "inspect feature pull request");
    const parsed = JSON.parse(output) as {
      number: number;
      title: string;
      url: string;
      state: FeaturePullRequestState["state"];
      isDraft: boolean;
      mergeable: FeaturePullRequestState["mergeable"];
      headRefName: string;
      headRepository: { name: string } | null;
      headRepositoryOwner: { login: string } | null;
      baseRefName: string;
      headRefOid: string;
      statusCheckRollup: Array<Record<string, unknown>>;
    };
    return {
      number: parsed.number,
      title: parsed.title,
      url: parsed.url,
      state: parsed.state,
      isDraft: parsed.isDraft,
      mergeable: parsed.mergeable,
      headRefName: parsed.headRefName,
      headRepositoryOwner: parsed.headRepositoryOwner?.login ?? "",
      headRepositoryName: parsed.headRepository?.name ?? "",
      baseRefName: parsed.baseRefName,
      headSha: parsed.headRefOid,
      checks: (parsed.statusCheckRollup ?? []).map(mapCheck)
    };
  }

  async merge(url: string, expectedHeadSha: string): Promise<void> {
    await runGh(
      ["pr", "merge", url, "--merge", "--match-head-commit", expectedHeadSha],
      "merge approved feature pull request"
    );
  }

  async markDraft(url: string): Promise<void> {
    const state = await this.inspect(url);
    if (state.state !== "OPEN" || state.isDraft) return;
    await runGh(["pr", "ready", "--undo", url], "return feature pull request to draft");
  }

  async closeSuperseded(url: string, featureUrl: string): Promise<void> {
    await this.close(url, `Superseded by the completed Feature PR ${featureUrl}.`);
  }

  async close(url: string, comment: string): Promise<void> {
    const state = await this.inspect(url);
    if (state.state !== "OPEN") return;
    await runGh([
      "pr",
      "close",
      url,
      "--comment",
      comment
    ], "close pull request");
  }

  async deleteHeadBranch(url: string): Promise<void> {
    const state = await this.inspect(url);
    if (!state.headRepositoryOwner || !state.headRepositoryName || !state.headRefName) {
      throw new Error("Cannot identify the pull request head repository and branch.");
    }
    if (state.headRefName === state.baseRefName) {
      throw new Error("Refusing to delete the pull request base branch.");
    }
    try {
      await runGh([
        "api",
        "--method",
        "DELETE",
        `repos/${state.headRepositoryOwner}/${state.headRepositoryName}/git/refs/heads/${state.headRefName}`
      ], "delete integrated pull request branch");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/HTTP 404|reference does not exist|git reference could not be found/i.test(message)) return;
      throw error;
    }
  }

  async closeIssue(url: string, issueNumber: number, comment: string): Promise<void> {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error("Cannot close GitHub issue: invalid issue number.");
    }
    const repository = repositoryFromPullRequestUrl(url);
    if (!repository) {
      throw new Error("Cannot identify the GitHub repository for issue closure.");
    }
    const output = await runGh([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repository,
      "--json",
      "state"
    ], "inspect linked GitHub issue");
    const issue = JSON.parse(output) as { state: string };
    if (issue.state.toUpperCase() === "CLOSED") return;
    await runGh([
      "issue",
      "close",
      String(issueNumber),
      "--repo",
      repository,
      "--comment",
      comment
    ], "close linked GitHub issue");
  }
}

function repositoryFromPullRequestUrl(url: string): string | null {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function featureChecksPassed(state: FeaturePullRequestState): boolean {
  return state.checks.length > 0 && state.checks.every((check) => (
    check.status === "COMPLETED"
    && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion)
  ));
}

function mapCheck(value: Record<string, unknown>): FeatureCheck {
  const name = readString(value.name) || readString(value.context) || "unnamed check";
  const contextState = readString(value.state).toUpperCase();
  const status = readString(value.status).toUpperCase() || (contextState ? "COMPLETED" : "UNKNOWN");
  const conclusion = readString(value.conclusion).toUpperCase() || contextState || "UNKNOWN";
  return { name, status, conclusion };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function runGh(args: string[], operation: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 2_000_000
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = redactSensitiveText((stderr || stdout || error.message).trim());
        reject(new Error(`Cannot ${operation}: ${detail || "unknown GitHub error"}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}
