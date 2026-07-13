import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  FeaturePlanIntegrationDetails,
  FeaturePlanRecord,
  FeatureRecord,
  MaestroDatabase
} from "../db.js";
import { GitCommandResult, runGit } from "../git.js";
import { redactSensitiveText, truncateForDisplay } from "../security/redaction.js";
import { GhFeatureGateway } from "./github.js";
import { FeatureIntegrationBuilder, WorkPullRequestGateway } from "./integration.js";

const EVENT_TEXT_MAX_LENGTH = 500;
const FEATURE_NAME_MAX_LENGTH = 100;

export interface FeatureAssemblyGitHubGateway {
  findOpenPullRequestByHead(worktreePath: string, branchName: string): Promise<string | null>;
  createDraftPullRequest(input: {
    worktreePath: string;
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<string>;
}

export class GhFeatureAssemblyGateway implements FeatureAssemblyGitHubGateway {
  async findOpenPullRequestByHead(worktreePath: string, branchName: string): Promise<string | null> {
    const result = runGhSafe(
      ["pr", "list", "--head", branchName, "--json", "url", "--jq", ".[0].url"],
      worktreePath
    );
    if (!result.ok) throw new Error(`Cannot inspect Feature PR for branch ${branchName}: ${gitOutput(result)}`);
    const url = result.stdout.trim();
    return url || null;
  }

  async createDraftPullRequest(input: {
    worktreePath: string;
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<string> {
    const created = runGhSafe(
      [
        "pr", "create", "--draft", "--base", input.baseBranch, "--head", input.branchName,
        "--title", input.title, "--body", input.body
      ],
      input.worktreePath
    );
    if (!created.ok) throw new Error(`Cannot create draft Feature pull request: ${gitOutput(created)}`);
    const url = created.stdout.trim().split(/\r?\n/).find((line) => /^https:\/\/github\.com\//.test(line));
    if (!url) throw new Error("GitHub CLI did not return a Feature pull request URL.");
    return url;
  }
}

export class FeatureAssemblyCoordinator {
  private readonly active = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private reconcilePromise: Promise<number> | null = null;

  constructor(
    private readonly database: MaestroDatabase,
    private readonly worktreesRoot: string,
    private readonly workGithub: WorkPullRequestGateway = new GhFeatureGateway(),
    private readonly assemblyGithub: FeatureAssemblyGitHubGateway = new GhFeatureAssemblyGateway(),
    private readonly pollIntervalMs = 15_000
  ) {}

  start(): void {
    if (this.timer) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reconcile(): Promise<number> {
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.reconcilePlans().finally(() => {
      this.reconcilePromise = null;
    });
    return this.reconcilePromise;
  }

  private async reconcilePlans(): Promise<number> {
    let changes = 0;
    const plans = this.database.listFeaturePlans(100).filter((plan) => plan.status === "planned");
    for (const plan of plans) {
      if (this.active.has(plan.id)) continue;
      this.active.add(plan.id);
      try {
        if (await this.reconcilePlan(plan.id)) changes += 1;
      } catch (error) {
        this.addPlanEvent(plan.id, "feature_plan.assembly_failed", safeSummary(error));
      } finally {
        this.active.delete(plan.id);
      }
    }
    return changes;
  }

  private async reconcilePlan(featurePlanId: number): Promise<boolean> {
    const existingFeature = this.database.findFeatureByFeaturePlanId(featurePlanId);
    if (existingFeature) {
      return this.ensureFeatureItemsRegistered(featurePlanId, existingFeature);
    }

    const integration = this.database.findFeaturePlanIntegrationByFeaturePlan(featurePlanId);
    if (integration?.status === "failed") return false;

    const details = this.database.getFeaturePlanDetails(featurePlanId);
    if (details.tasks.length === 0) return false;
    const eligible = details.tasks.every((task) => task.taskStatus === "ready_to_merge");
    if (!eligible) return false;

    return this.assemblePlan(details.plan);
  }

  private async assemblePlan(plan: FeaturePlanRecord): Promise<boolean> {
    const project = this.database.getProjectByKey(plan.projectKey);
    const builder = new FeatureIntegrationBuilder(this.database, this.worktreesRoot, this.workGithub);
    const integrationDetails = await builder.build(plan.id);
    const { integration } = integrationDetails;

    requireGit(
      runGitSafe(["push", "-u", "origin", integration.branchName], integration.worktreePath),
      "push Feature integration branch"
    );

    const title = buildFeatureTitle(plan);
    const existingUrl = await this.assemblyGithub.findOpenPullRequestByHead(integration.worktreePath, integration.branchName);
    const pullRequestUrl = existingUrl
      ? existingUrl
      : await this.assemblyGithub.createDraftPullRequest({
        worktreePath: integration.worktreePath,
        branchName: integration.branchName,
        baseBranch: project.defaultBranch,
        title,
        body: buildFeatureBody(plan, integrationDetails)
      });

    const feature = this.database.createFeature({
      projectKey: project.key,
      featurePlanId: plan.id,
      name: title,
      objective: plan.objective,
      branchName: integration.branchName,
      worktreePath: integration.worktreePath,
      pullRequestUrl
    });

    this.ensureFeatureItemsRegistered(plan.id, feature, integrationDetails);
    this.addPlanEvent(
      plan.id,
      "feature_plan.assembled",
      `Feature Plan #${plan.id} assembled into Feature PR ${pullRequestUrl}.`,
      feature.id
    );
    return true;
  }

  private ensureFeatureItemsRegistered(
    featurePlanId: number,
    feature: FeatureRecord,
    integrationDetails?: FeaturePlanIntegrationDetails
  ): boolean {
    const details = integrationDetails
      ?? this.database.getFeaturePlanIntegrationDetailsByFeaturePlan(featurePlanId);
    if (!details) return false;
    const before = this.database.listFeatureItems(feature.id).length;
    for (const item of details.items) {
      this.database.addFeatureItem({
        featureId: feature.id,
        taskId: item.taskId,
        pullRequestUrl: item.pullRequestUrl,
        branchName: item.branchName
      });
    }
    const after = this.database.listFeatureItems(feature.id).length;
    return after > before;
  }

  private addPlanEvent(featurePlanId: number, type: string, text: string, featureId?: number): void {
    this.database.addEvent({
      source: "maestro",
      type,
      text: truncateForDisplay(redactSensitiveText(text), EVENT_TEXT_MAX_LENGTH),
      metadata: { featurePlanId, featureId: featureId ?? null }
    });
  }
}

function buildFeatureTitle(plan: FeaturePlanRecord): string {
  const objective = singleLine(plan.objective);
  return truncateForDisplay(`Feature Plan #${plan.id}: ${objective}`, FEATURE_NAME_MAX_LENGTH);
}

function buildFeatureBody(plan: FeaturePlanRecord, details: FeaturePlanIntegrationDetails): string {
  const lines: string[] = [
    `Automated Feature PR assembled from Feature Plan #${plan.id}.`,
    "",
    "## Objective",
    plan.objective,
    ""
  ];
  if (plan.acceptanceCriteria.length > 0) {
    lines.push("## Acceptance Criteria", ...plan.acceptanceCriteria.map((item) => `- ${item}`), "");
  }
  lines.push("## Tasks");
  for (const item of details.items) {
    lines.push(`- Task #${item.taskId}: ${singleLine(item.taskText)}`);
    lines.push(`  - Work PR: ${item.pullRequestUrl}`);
    lines.push(`  - Commit: ${item.commitSha}`);
  }
  lines.push(
    "",
    "## Evidence",
    "Each commit above was cherry-picked exactly from its delivered, reviewed Work PR head onto this",
    "single deterministic integration branch. Work PRs remain open as isolated evidence and are not merged directly.",
    "",
    "This pull request is intentionally a draft; marking it ready for review authorizes the final gated completion protocol."
  );
  return lines.join("\n");
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function runGitSafe(args: string[], cwd: string): GitCommandResult {
  return runGit(["-c", `safe.directory=${path.resolve(cwd)}`, ...args], cwd);
}

function runGhSafe(args: string[], cwd: string): GitCommandResult {
  const result = spawnSync("gh", args, { cwd, encoding: "utf8", windowsHide: true });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status
  };
}

function requireGit(result: GitCommandResult, operation: string): GitCommandResult {
  if (!result.ok) throw new Error(`Cannot ${operation}: ${gitOutput(result)}`);
  return result;
}

function gitOutput(result: GitCommandResult): string {
  return redactSensitiveText((result.stderr || result.stdout || `command exited ${result.exitCode ?? "unknown"}`).trim());
}

function safeSummary(error: unknown): string {
  return truncateForDisplay(
    redactSensitiveText(error instanceof Error ? error.message : "Unknown Feature Plan assembly error."),
    EVENT_TEXT_MAX_LENGTH
  );
}
