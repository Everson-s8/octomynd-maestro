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
  baseRefName: string;
  headSha: string;
  checks: FeatureCheck[];
};

export interface FeatureGitHubGateway {
  inspect(url: string): Promise<FeaturePullRequestState>;
  merge(url: string, expectedHeadSha: string): Promise<void>;
  markDraft(url: string): Promise<void>;
  closeSuperseded(url: string, featureUrl: string): Promise<void>;
}

export class GhFeatureGateway implements FeatureGitHubGateway {
  async inspect(url: string): Promise<FeaturePullRequestState> {
    const output = await runGh([
      "pr",
      "view",
      url,
      "--json",
      "number,title,url,state,isDraft,mergeable,headRefName,baseRefName,headRefOid,statusCheckRollup"
    ], "inspect feature pull request");
    const parsed = JSON.parse(output) as {
      number: number;
      title: string;
      url: string;
      state: FeaturePullRequestState["state"];
      isDraft: boolean;
      mergeable: FeaturePullRequestState["mergeable"];
      headRefName: string;
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
    const state = await this.inspect(url);
    if (state.state !== "OPEN") return;
    await runGh([
      "pr",
      "close",
      url,
      "--delete-branch",
      "--comment",
      `Superseded by the completed Feature PR ${featureUrl}.`
    ], "close superseded work pull request");
  }
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
