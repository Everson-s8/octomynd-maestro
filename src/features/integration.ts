import fs from "node:fs";
import path from "node:path";
import {
  FeaturePlanDetails,
  FeaturePlanIntegrationDetails,
  FeaturePlanIntegrationItemInput,
  FeaturePlanIntegrationItemRecord,
  FeaturePlanIntegrationRecord,
  FeaturePlanRecord,
  GoalRunRecord,
  MaestroDatabase,
  ProjectRecord
} from "../db.js";
import { GitCommandResult, runGit } from "../git.js";
import { redactSensitiveText, truncateForDisplay } from "../security/redaction.js";
import { formatSecretScanFinding, scanWorktreePathsForSecrets } from "../security/secrets.js";
import { FeaturePullRequestState, GhFeatureGateway } from "./github.js";

const EVENT_TEXT_MAX_LENGTH = 500;

export type FeatureIntegrationPlan = {
  branchName: string;
  worktreePath: string;
};

export interface WorkPullRequestGateway {
  inspect(url: string): Promise<FeaturePullRequestState>;
}

export class FeatureIntegrationBuilder {
  constructor(
    private readonly database: MaestroDatabase,
    private readonly worktreesRoot: string,
    private readonly github: WorkPullRequestGateway = new GhFeatureGateway()
  ) {}

  async build(featurePlanId: number): Promise<FeaturePlanIntegrationDetails> {
    let integration = this.database.findFeaturePlanIntegrationByFeaturePlan(featurePlanId);
    try {
      const details = this.database.getFeaturePlanDetails(featurePlanId);
      const project = this.database.getProjectByKey(details.plan.projectKey);
      this.validatePlan(details.plan);

      if (integration?.planRevision !== undefined && integration.planRevision !== details.plan.revision) {
        throw new Error(`Feature Plan #${featurePlanId} changed after integration started.`);
      }
      if (integration?.status === "completed") {
        return this.database.getFeaturePlanIntegrationDetails(integration.id);
      }
      if (integration?.status === "failed") {
        throw new Error(`Feature Plan integration #${integration.id} already failed: ${integration.lastError ?? "unknown error"}`);
      }

      if (!integration) {
        const validatedItems = await this.validateWorkItems(details, project);
        integration = this.createIntegration(details.plan, project);
        this.ensureItems(integration, validatedItems);
        this.addEvent("feature_plan.integration_started", `Feature Plan #${details.plan.id} integration started.`, integration);
      } else if (this.database.listFeaturePlanIntegrationItems(integration.id).length === 0) {
        const validatedItems = await this.validateWorkItems(details, project);
        this.ensureItems(integration, validatedItems);
      } else {
        await this.revalidatePersistedItems(integration, project);
      }

      integration = this.database.updateFeaturePlanIntegration({
        id: integration.id,
        status: "preparing",
        checkpoint: "validated",
        lastError: null
      });
      integration = this.prepareWorktree(project, integration);
      integration = this.integrateItems(project, integration);
      integration = this.verifyIntegratedDiff(integration);

      const completed = this.database.updateFeaturePlanIntegration({
        id: integration.id,
        status: "completed",
        checkpoint: "completed",
        headSha: readHead(integration.worktreePath),
        lastError: null,
        completedAt: new Date().toISOString()
      });
      this.addEvent("feature_plan.integration_completed", `Feature Plan #${details.plan.id} integrated locally.`, completed);
      return this.database.getFeaturePlanIntegrationDetails(completed.id);
    } catch (error) {
      const message = safeSummary(error);
      if (integration && integration.status !== "completed") {
        const failed = this.database.updateFeaturePlanIntegration({
          id: integration.id,
          status: "failed",
          checkpoint: "failed",
          lastError: message
        });
        this.addEvent("feature_plan.integration_failed", message, failed);
      }
      throw error;
    }
  }

  private validatePlan(plan: FeaturePlanRecord): void {
    if (plan.status !== "planned") {
      throw new Error(`Feature Plan #${plan.id} cannot be integrated from status ${plan.status}.`);
    }
  }

  private async validateWorkItems(
    details: FeaturePlanDetails,
    project: ProjectRecord
  ): Promise<FeaturePlanIntegrationItemInput[]> {
    const items: FeaturePlanIntegrationItemInput[] = [];
    for (const planTask of details.tasks) {
      const task = this.database.getTask(planTask.taskId);
      if (task.status !== "awaiting_human") {
        throw new Error(`Task #${task.id} must have a delivered Draft Work PR before Feature Plan integration.`);
      }
      if (!task.branchName) {
        throw new Error(`Task #${task.id} has no branch recorded for Work PR validation.`);
      }
      const run = this.requireCompletedDeliveredGoal(task.id);
      const state = await this.github.inspect(run.pullRequestUrl!);
      validateWorkPullRequest({
        taskId: task.id,
        project,
        branchName: task.branchName,
        commitSha: run.commitSha!,
        state
      });
      items.push({
        integrationId: 0,
        featurePlanId: details.plan.id,
        taskId: task.id,
        position: planTask.position,
        commitSha: run.commitSha!,
        pullRequestUrl: run.pullRequestUrl!,
        branchName: task.branchName
      });
    }
    return items;
  }

  private async revalidatePersistedItems(
    integration: FeaturePlanIntegrationRecord,
    project: ProjectRecord
  ): Promise<void> {
    for (const item of this.database.listFeaturePlanIntegrationItems(integration.id)) {
      const task = this.database.getTask(item.taskId);
      if (task.status !== "awaiting_human") {
        throw new Error(`Task #${task.id} no longer has a delivered Draft Work PR.`);
      }
      const state = await this.github.inspect(item.pullRequestUrl);
      validateWorkPullRequest({
        taskId: item.taskId,
        project,
        branchName: item.branchName,
        commitSha: item.commitSha,
        state
      });
    }
  }

  private createIntegration(plan: FeaturePlanRecord, project: ProjectRecord): FeaturePlanIntegrationRecord {
    const integrationPlan = createFeatureIntegrationPlan(project, plan, this.worktreesRoot);
    return this.database.createFeaturePlanIntegration({
      featurePlanId: plan.id,
      projectId: project.id,
      planRevision: plan.revision,
      branchName: integrationPlan.branchName,
      worktreePath: integrationPlan.worktreePath
    });
  }

  private ensureItems(
    integration: FeaturePlanIntegrationRecord,
    inputs: FeaturePlanIntegrationItemInput[]
  ): void {
    for (const input of inputs) {
      this.database.ensureFeaturePlanIntegrationItem({
        ...input,
        integrationId: integration.id
      });
    }
  }

  private requireCompletedDeliveredGoal(taskId: number): GoalRunRecord {
    const run = this.database.findLatestCompletedGoalRunForTask(taskId);
    if (!run) throw new Error(`Task #${taskId} has no completed Goal to integrate.`);
    if (!run.commitSha || !/^[a-f0-9]{40}$/i.test(run.commitSha)) {
      throw new Error(`Task #${taskId} completed Goal has no exact delivery commit SHA.`);
    }
    if (!run.pullRequestUrl) {
      throw new Error(`Task #${taskId} completed Goal has no Work PR URL.`);
    }
    return run;
  }

  private prepareWorktree(
    project: ProjectRecord,
    integration: FeaturePlanIntegrationRecord
  ): FeaturePlanIntegrationRecord {
    let current = integration;
    if (!current.baseSha) {
      requireGit(
        runGitSafe(["fetch", "origin", project.defaultBranch], project.path),
        `fetch origin/${project.defaultBranch}`
      );
      const baseSha = requireGit(
        runGitSafe(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], project.path),
        `resolve origin/${project.defaultBranch}`
      ).stdout.trim().toLowerCase();
      current = this.database.updateFeaturePlanIntegration({
        id: current.id,
        checkpoint: "base_fetched",
        baseSha,
        headSha: baseSha,
        lastError: null
      });
    }

    fs.mkdirSync(path.dirname(current.worktreePath), { recursive: true });
    if (!fs.existsSync(current.worktreePath)) {
      const branchExists = runGitSafe(["show-ref", "--verify", "--quiet", `refs/heads/${current.branchName}`], project.path).ok;
      const args = branchExists
        ? ["worktree", "add", current.worktreePath, current.branchName]
        : ["worktree", "add", "-b", current.branchName, current.worktreePath, current.baseSha!];
      requireGit(runGitSafe(args, project.path), "create integration worktree");
    }

    const branch = requireGit(
      runGitSafe(["rev-parse", "--abbrev-ref", "HEAD"], current.worktreePath),
      "inspect integration worktree branch"
    ).stdout.trim();
    if (branch !== current.branchName) {
      throw new Error(`Integration worktree is on ${branch}, expected ${current.branchName}.`);
    }
    requireCleanWorktree(current.worktreePath);
    const headSha = readHead(current.worktreePath);
    return this.database.updateFeaturePlanIntegration({
      id: current.id,
      status: "integrating",
      checkpoint: "worktree_created",
      headSha,
      lastError: null
    });
  }

  private integrateItems(
    project: ProjectRecord,
    integration: FeaturePlanIntegrationRecord
  ): FeaturePlanIntegrationRecord {
    let current = this.database.updateFeaturePlanIntegration({
      id: integration.id,
      status: "integrating",
      checkpoint: "integrating",
      lastError: null
    });

    for (const item of this.database.listFeaturePlanIntegrationItems(current.id)) {
      if (item.status === "failed") {
        throw new Error(`Task #${item.taskId} integration item already failed: ${item.lastError ?? "unknown error"}`);
      }
      if (item.status === "integrated") {
        this.requireAppliedCheckpoint(item);
        continue;
      }

      requireCleanWorktree(current.worktreePath);
      ensureCommitAvailable(project, current.worktreePath, item);
      const existingAppliedCommit = findAppliedCherryPickCommit(current.worktreePath, item.commitSha);
      if (existingAppliedCommit) {
        this.database.updateFeaturePlanIntegrationItem({
          id: item.id,
          status: "integrated",
          appliedCommitSha: existingAppliedCommit,
          lastError: null
        });
        current = this.database.updateFeaturePlanIntegration({
          id: current.id,
          checkpoint: "integrating",
          headSha: readHead(current.worktreePath),
          lastError: null
        });
        continue;
      }
      if (isCommitAncestor(current.worktreePath, item.commitSha)) {
        this.database.updateFeaturePlanIntegrationItem({
          id: item.id,
          status: "integrated",
          appliedCommitSha: item.commitSha,
          lastError: null
        });
        current = this.database.updateFeaturePlanIntegration({
          id: current.id,
          checkpoint: "integrating",
          headSha: readHead(current.worktreePath),
          lastError: null
        });
        continue;
      }

      const picked = runGitSafe(["cherry-pick", "-x", item.commitSha], current.worktreePath);
      if (!picked.ok) {
        runGitSafe(["cherry-pick", "--abort"], current.worktreePath);
        const message = `Cannot cherry-pick task #${item.taskId} commit ${shortSha(item.commitSha)}: ${gitOutput(picked)}`;
        this.database.updateFeaturePlanIntegrationItem({
          id: item.id,
          status: "failed",
          lastError: safeSummary(message)
        });
        throw new Error(message);
      }
      const appliedCommitSha = readHead(current.worktreePath);
      this.database.updateFeaturePlanIntegrationItem({
        id: item.id,
        status: "integrated",
        appliedCommitSha,
        lastError: null
      });
      current = this.database.updateFeaturePlanIntegration({
        id: current.id,
        checkpoint: "integrating",
        headSha: appliedCommitSha,
        lastError: null
      });
      this.addEvent("feature_plan.integration_item_integrated", `Task #${item.taskId} commit integrated.`, current, item.taskId);
    }

    return this.database.updateFeaturePlanIntegration({
      id: current.id,
      checkpoint: "commits_integrated",
      headSha: readHead(current.worktreePath),
      lastError: null
    });
  }

  private requireAppliedCheckpoint(item: FeaturePlanIntegrationItemRecord): void {
    if (!item.appliedCommitSha) {
      throw new Error(`Task #${item.taskId} integration item has no applied commit checkpoint.`);
    }
    const worktreePath = this.database.getFeaturePlanIntegration(item.integrationId).worktreePath;
    if (!commitExists(worktreePath, item.appliedCommitSha)) {
      throw new Error(`Task #${item.taskId} applied commit checkpoint is missing from the integration worktree.`);
    }
    if (!isCommitAncestor(worktreePath, item.appliedCommitSha)) {
      throw new Error(`Task #${item.taskId} applied commit checkpoint is not reachable from integration HEAD.`);
    }
  }

  private verifyIntegratedDiff(integration: FeaturePlanIntegrationRecord): FeaturePlanIntegrationRecord {
    if (!integration.baseSha) {
      throw new Error(`Feature Plan integration #${integration.id} has no base SHA checkpoint.`);
    }
    requireCleanWorktree(integration.worktreePath);
    const changedFiles = listChangedFiles(integration.worktreePath, integration.baseSha);
    const findings = scanWorktreePathsForSecrets(integration.worktreePath, changedFiles).map(formatSecretScanFinding);
    if (findings.length > 0) {
      throw new Error(`Secret guard blocked Feature Plan integration: ${findings.join(", ")}`);
    }
    let current = this.database.updateFeaturePlanIntegration({
      id: integration.id,
      status: "verifying",
      checkpoint: "secret_scan_passed",
      headSha: readHead(integration.worktreePath),
      lastError: null
    });

    requireGit(
      runGitSafe(["diff", "--check", `${integration.baseSha}..HEAD`], integration.worktreePath),
      "validate integration diff whitespace"
    );
    current = this.database.updateFeaturePlanIntegration({
      id: current.id,
      checkpoint: "diff_check_passed",
      headSha: readHead(integration.worktreePath),
      lastError: null
    });
    return current;
  }

  private addEvent(type: string, text: string, integration: FeaturePlanIntegrationRecord, taskId?: number): void {
    this.database.addEvent({
      source: "maestro",
      type,
      text: truncateForDisplay(redactSensitiveText(text), EVENT_TEXT_MAX_LENGTH),
      taskId: taskId ?? null,
      metadata: {
        featurePlanId: integration.featurePlanId,
        integrationId: integration.id,
        status: integration.status,
        checkpoint: integration.checkpoint,
        branchName: integration.branchName
      }
    });
  }
}

export function createFeatureIntegrationPlan(
  project: ProjectRecord,
  plan: FeaturePlanRecord,
  worktreesRoot: string
): FeatureIntegrationPlan {
  return {
    branchName: `maestro/feature-plan-${plan.id}-r${plan.revision}`,
    worktreePath: path.join(worktreesRoot, project.key, `feature-plan-${plan.id}`)
  };
}

function validateWorkPullRequest(input: {
  taskId: number;
  project: ProjectRecord;
  branchName: string;
  commitSha: string;
  state: FeaturePullRequestState;
}): void {
  const { taskId, project, branchName, commitSha, state } = input;
  if (state.state !== "OPEN") {
    throw new Error(`Task #${taskId} Work PR must be open before Feature Plan integration.`);
  }
  if (!state.isDraft) {
    throw new Error(`Task #${taskId} Work PR must remain Draft; only the consolidated Feature PR can be marked ready.`);
  }
  if (state.mergeable === "CONFLICTING") {
    throw new Error(`Task #${taskId} Work PR reports merge conflicts.`);
  }
  if (state.baseRefName !== project.defaultBranch) {
    throw new Error(`Task #${taskId} Work PR targets ${state.baseRefName}, expected ${project.defaultBranch}.`);
  }
  if (state.headRefName !== branchName) {
    throw new Error(`Task #${taskId} Work PR head ${state.headRefName} does not match recorded branch ${branchName}.`);
  }
  if (state.headSha.toLowerCase() !== commitSha.toLowerCase()) {
    throw new Error(`Task #${taskId} Work PR head does not match delivered commit ${shortSha(commitSha)}.`);
  }
}

function ensureCommitAvailable(
  project: ProjectRecord,
  worktreePath: string,
  item: FeaturePlanIntegrationItemRecord
): void {
  if (commitExists(worktreePath, item.commitSha)) return;
  runGitSafe(["fetch", "origin", item.branchName], worktreePath);
  if (commitExists(worktreePath, item.commitSha)) return;
  const pullNumber = item.pullRequestUrl.match(/\/pull\/(\d+)\/?$/)?.[1];
  if (pullNumber) runGitSafe(["fetch", "origin", `pull/${pullNumber}/head`], worktreePath);
  if (commitExists(worktreePath, item.commitSha)) return;
  requireGit(
    runGitSafe(["fetch", "origin", item.branchName], project.path),
    `fetch Work PR branch for task #${item.taskId}`
  );
  if (!commitExists(worktreePath, item.commitSha)) {
    throw new Error(`Cannot find exact commit ${shortSha(item.commitSha)} for task #${item.taskId}.`);
  }
}

function commitExists(worktreePath: string, commitSha: string): boolean {
  return runGitSafe(["cat-file", "-e", `${commitSha}^{commit}`], worktreePath).ok;
}

function findAppliedCherryPickCommit(worktreePath: string, commitSha: string): string | null {
  const result = runGitSafe([
    "log",
    "--grep",
    commitSha,
    "--format=%H"
  ], worktreePath);
  if (!result.ok) return null;
  return result.stdout.trim().split(/\r?\n/).find(Boolean) ?? null;
}

function isCommitAncestor(worktreePath: string, commitSha: string): boolean {
  const result = runGitSafe(["merge-base", "--is-ancestor", commitSha, "HEAD"], worktreePath);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error(`Cannot inspect whether ${shortSha(commitSha)} is already integrated: ${gitOutput(result)}`);
}

function listChangedFiles(worktreePath: string, baseSha: string): string[] {
  const result = requireGit(
    runGitSafe(["diff", "--name-only", "-z", `${baseSha}..HEAD`], worktreePath),
    "list integrated changed files"
  );
  return splitNull(result.stdout);
}

function requireCleanWorktree(worktreePath: string): void {
  const status = requireGit(runGitSafe(["status", "--porcelain"], worktreePath), "inspect integration worktree status");
  if (status.stdout.trim()) {
    throw new Error("Integration worktree is dirty; refusing to continue.");
  }
}

function readHead(worktreePath: string): string {
  return requireGit(runGitSafe(["rev-parse", "HEAD"], worktreePath), "read integration HEAD").stdout.trim().toLowerCase();
}

function runGitSafe(args: string[], cwd: string): GitCommandResult {
  return runGit(["-c", `safe.directory=${path.resolve(cwd)}`, ...args], cwd);
}

function requireGit(result: GitCommandResult, operation: string): GitCommandResult {
  if (!result.ok) throw new Error(`Cannot ${operation}: ${gitOutput(result)}`);
  return result;
}

function gitOutput(result: GitCommandResult): string {
  return redactSensitiveText((result.stderr || result.stdout || `git exited ${result.exitCode ?? "unknown"}`).trim());
}

function safeSummary(error: unknown): string {
  return truncateForDisplay(
    redactSensitiveText(error instanceof Error ? error.message : "Unknown Feature Plan integration error."),
    EVENT_TEXT_MAX_LENGTH
  );
}

function splitNull(value: string): string[] {
  return value.split("\0").map((item) => item.trim()).filter(Boolean);
}

function shortSha(value: string): string {
  return value.slice(0, 8);
}
