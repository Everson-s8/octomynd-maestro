import { spawn } from "node:child_process";
import path from "node:path";
import { FeatureRecord, MaestroDatabase, RuntimeUpdateRecord } from "../db.js";
import { runGit } from "../git.js";

export type SelfUpdateNotificationEvent =
  | { type: "start"; targetCommit: string; pullRequestUrl?: string }
  | { type: "commit"; resultingCommit: string }
  | { type: "success"; resultingCommit: string }
  | { type: "failure"; commit: string; error: string }
  | { type: "rollback"; previousCommit: string; error: string };

export type SelfUpdateNotificationHandler = (event: SelfUpdateNotificationEvent) => Promise<void>;

export type ProcessRunner = (
  cmd: string,
  args: string[],
  cwd: string
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export class SelfUpdateManager {
  constructor(
    private readonly database: MaestroDatabase,
    private readonly repoPath: string,
    private readonly scriptPath: string = path.join(repoPath, "scripts", "maestro-runtime.ps1"),
    private readonly notify?: SelfUpdateNotificationHandler,
    private readonly customRunner?: ProcessRunner
  ) {}

  async triggerUpdate(feature: FeatureRecord, expectedFeatureHead: string): Promise<RuntimeUpdateRecord> {
    const currentCommit = await this.getCurrentHeadCommit();
    const targetCommit = await this.resolveMergedMainCommit(expectedFeatureHead);
    const record = this.database.enqueueRuntimeUpdate({
      featureId: feature.id,
      targetCommit,
      previousCommit: currentCommit
    });
    if (record.status !== "pending") return record;
    return this.executeSelfUpdate(record, feature.pullRequestUrl);
  }

  async executeSelfUpdate(record: RuntimeUpdateRecord, pullRequestUrl?: string): Promise<RuntimeUpdateRecord> {
    await this.emitNotify({ type: "start", targetCommit: record.targetCommit, pullRequestUrl });
    if (!(await this.checkWorktreeClean())) {
      return this.fail(record, "Worktree possesses uncommitted changes. Refusing to update.");
    }

    const inProgress = this.database.updateRuntimeUpdate({ id: record.id, status: "in_progress" });
    await this.emitNotify({ type: "commit", resultingCommit: record.targetCommit });
    try {
      await this.launchSupervisedRestart(record.targetCommit, record.previousCommit);
      return inProgress;
    } catch (error) {
      return this.fail(record, error instanceof Error ? error.message : "Unable to launch supervised restart.");
    }
  }

  async reconcileLatestUpdate(): Promise<RuntimeUpdateRecord | null> {
    const record = this.database.getLatestRuntimeUpdate();
    if (!record || record.status !== "in_progress") return record;
    const currentCommit = await this.getCurrentHeadCommit();
    if (currentCommit === record.targetCommit) {
      const completed = this.database.updateRuntimeUpdate({ id: record.id, status: "completed" });
      this.database.addEvent({
        source: "maestro",
        type: "self_update.completed",
        text: `Self-update completed successfully at commit ${currentCommit}.`,
        metadata: { updateId: record.id, commit: currentCommit }
      });
      await this.emitNotify({ type: "success", resultingCommit: currentCommit });
      return completed;
    }
    if (currentCommit === record.previousCommit) {
      const error = "The supervised restart rolled back to the previous known-good commit.";
      const rolledBack = this.database.updateRuntimeUpdate({ id: record.id, status: "rolled_back", error });
      await this.emitNotify({ type: "rollback", previousCommit: currentCommit, error });
      return rolledBack;
    }
    return this.fail(record, `Runtime restarted at unexpected commit ${currentCommit}.`);
  }

  private async resolveMergedMainCommit(expectedFeatureHead: string): Promise<string> {
    const fetchResult = await this.run("git", ["fetch", "origin", "main"]);
    if (!fetchResult.ok) throw new Error(fetchResult.stderr || "Unable to fetch origin/main.");
    const contains = await this.run("git", ["merge-base", "--is-ancestor", expectedFeatureHead, "origin/main"]);
    if (!contains.ok) throw new Error("Merged Feature head is not contained in origin/main.");
    const resolved = await this.run("git", ["rev-parse", "origin/main"]);
    if (!resolved.ok || !resolved.stdout.trim()) throw new Error(resolved.stderr || "Unable to resolve origin/main.");
    return resolved.stdout.trim();
  }

  private async getCurrentHeadCommit(): Promise<string> {
    const result = await this.run("git", ["rev-parse", "HEAD"]);
    if (!result.ok || !result.stdout.trim()) throw new Error(result.stderr || "Unable to resolve HEAD.");
    return result.stdout.trim();
  }

  private async checkWorktreeClean(): Promise<boolean> {
    const result = await this.run("git", ["status", "--porcelain"]);
    return result.ok && result.stdout.trim().length === 0;
  }

  private async launchSupervisedRestart(targetCommit: string, previousCommit: string): Promise<void> {
    const args = [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath,
      "-Action", "apply-update", "-TargetCommit", targetCommit, "-PreviousCommit", previousCommit
    ];
    if (this.customRunner) {
      const result = await this.customRunner("powershell.exe", args, this.repoPath);
      if (!result.ok) throw new Error(result.stderr || result.stdout || "Unable to launch supervised restart.");
      return;
    }
    const child = spawn("powershell.exe", args, {
      cwd: this.repoPath,
      detached: true,
      windowsHide: true,
      stdio: "ignore"
    });
    child.unref();
  }

  private async run(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    if (this.customRunner) return this.customRunner(cmd, args, this.repoPath);
    return runGit(args, this.repoPath);
  }

  private async fail(record: RuntimeUpdateRecord, error: string): Promise<RuntimeUpdateRecord> {
    const failed = this.database.updateRuntimeUpdate({ id: record.id, status: "failed", error });
    this.database.addEvent({
      source: "maestro",
      type: "self_update.failed",
      text: error,
      metadata: { updateId: record.id, targetCommit: record.targetCommit }
    });
    await this.emitNotify({ type: "failure", commit: record.targetCommit, error });
    return failed;
  }

  private async emitNotify(event: SelfUpdateNotificationEvent): Promise<void> {
    if (!this.notify) return;
    try {
      await this.notify(event);
    } catch {
      // Best effort notification.
    }
  }
}
