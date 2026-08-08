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

export type FeatureAssemblyEvent =
  | { type: "started"; plan: FeaturePlanRecord }
  | { type: "draft_ready"; plan: FeaturePlanRecord; feature: FeatureRecord }
  | { type: "blocked"; plan: FeaturePlanRecord; message: string };

export type FeatureAssemblyNotificationHandler = (event: FeatureAssemblyEvent) => Promise<void>;

export class FeatureAssemblyCoordinator {
  private readonly active = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private reconcilePromise: Promise<number> | null = null;

  constructor(
    private readonly database: MaestroDatabase,
    private readonly worktreesRoot: string,
    private readonly workGithub: WorkPullRequestGateway = new GhFeatureGateway(),
    private readonly assemblyGithub: FeatureAssemblyGitHubGateway = new GhFeatureAssemblyGateway(),
    private readonly notify?: FeatureAssemblyNotificationHandler,
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
    const plans = this.database.listFeaturePlans(100).filter((plan) => !["completed", "cancelled"].includes(plan.status));
    for (const plan of plans) {
      if (this.active.has(plan.id)) continue;
      this.active.add(plan.id);
      try {
        if (await this.reconcilePlan(plan.id)) changes += 1;
      } catch (error) {
        const message = safeSummary(error);
        if (!this.database.hasFeaturePlanEvent("feature_plan.assembly_failed", plan.id, plan.revision)) {
          this.addPlanEvent(plan.id, "feature_plan.assembly_failed", message, undefined, plan.revision);
          await this.emitNotify({ type: "blocked", plan, message });
        }
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
    const eligible = details.tasks.every((task) => task.taskStatus === "awaiting_human");
    if (!eligible) return false;

    if (details.plan.status === "queued") {
      const queueEligibility = this.database.evaluateFeaturePlanEligibility(featurePlanId);
      if (!queueEligibility.eligible) return false;
    }

    return this.assemblePlan(details.plan);
  }

  private async assemblePlan(plan: FeaturePlanRecord): Promise<boolean> {
    const isFirstAttempt = this.database.findFeaturePlanIntegrationByFeaturePlan(plan.id) === null;
    if (isFirstAttempt) await this.emitNotify({ type: "started", plan });

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
        body: buildFeatureBody(
          plan,
          integrationDetails,
          this.database.getFeaturePlanIssueLinks(plan.id)
        )
      });

    const wasFeatureAlreadyCreated = this.database.findFeatureByFeaturePlanId(plan.id) !== null;
    const feature = this.database.createFeature({
      projectKey: project.key,
      featurePlanId: plan.id,
      name: title,
      objective: plan.objective,
      branchName: integration.branchName,
      worktreePath: integration.worktreePath,
      pullRequestUrl
    });

    const currentPlan = this.database.getFeaturePlan(plan.id);
    if (currentPlan.status === "active") {
      this.database.updateFeaturePlanQueueStatus(plan.id, "waiting_review");
    }

    this.ensureFeatureItemsRegistered(plan.id, feature, integrationDetails);
    this.addPlanEvent(
      plan.id,
      "feature_plan.assembled",
      `Feature Plan #${plan.id} assembled into Feature PR ${pullRequestUrl}.`,
      feature.id,
      plan.revision
    );
    if (!wasFeatureAlreadyCreated) await this.emitNotify({ type: "draft_ready", plan, feature });
    return true;
  }

  private async emitNotify(event: FeatureAssemblyEvent): Promise<void> {
    if (!this.notify) return;
    if (this.database.hasFeaturePlanEvent(
      "feature_plan.assembly_notification_sent",
      event.plan.id,
      event.plan.revision,
      event.type
    )) return;
    try {
      await this.notify(event);
      this.database.addEvent({
        source: "maestro",
        type: "feature_plan.assembly_notification_sent",
        text: `Feature Plan #${event.plan.id} assembly notification sent (${event.type}).`,
        metadata: {
          featurePlanId: event.plan.id,
          revision: event.plan.revision,
          eventType: event.type
        }
      });
    } catch (error) {
      this.addPlanEvent(event.plan.id, "feature_plan.assembly_notification_failed", safeSummary(error));
    }
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

  private addPlanEvent(
    featurePlanId: number,
    type: string,
    text: string,
    featureId?: number,
    revision?: number
  ): void {
    this.database.addEvent({
      source: "maestro",
      type,
      text: truncateForDisplay(redactSensitiveText(text), EVENT_TEXT_MAX_LENGTH),
      metadata: { featurePlanId, featureId: featureId ?? null, revision: revision ?? null }
    });
  }
}

function buildFeatureTitle(plan: FeaturePlanRecord): string {
  const objective = singleLine(plan.objective);
  return truncateForDisplay(`Feature Plan #${plan.id}: ${objective}`, FEATURE_NAME_MAX_LENGTH);
}

function buildFeatureBody(
  plan: FeaturePlanRecord,
  details: FeaturePlanIntegrationDetails,
  issueLinks: ReturnType<MaestroDatabase["getFeaturePlanIssueLinks"]>
): string {
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
  const closingReferences = [
    issueLinks.featureIssueNumber,
    ...Object.values(issueLinks.taskIssueNumbers)
  ].filter((issueNumber): issueNumber is number => issueNumber !== null);
  if (closingReferences.length > 0) {
    lines.push(
      "## GitHub lifecycle",
      ...[...new Set(closingReferences)].map((issueNumber) => `Closes #${issueNumber}`),
      ""
    );
  }
  lines.push("## Tasks");
  for (const item of details.items) {
    const issueNumber = issueLinks.taskIssueNumbers[item.taskId];
    lines.push(`- Task #${item.taskId}${issueNumber ? ` / GitHub #${issueNumber}` : ""}: ${singleLine(item.taskText)}`);
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
