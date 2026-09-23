import fs from "node:fs";
import path from "node:path";
import { captureWorkspaceProgress } from "../goals/circuit-breaker.js";
import type { GoalPhase, MaestroDatabase } from "../db.js";
import { GLOBAL_CHAT_PROJECT_KEY, type ChatAccessMode, type ChatLocale } from "./types.js";
import { executeChatCommand, formatChatCommandEvidence, planChatCommand, isLongRunningCommand } from "./project-command.js";

const RECOVERY_COMMAND_TIMEOUT_MS = 10 * 60_000;

export type GoalWorkspaceRecoveryInput = {
  database: MaestroDatabase;
  runId: number;
  command: string;
  projectKey: string;
  registeredProjectPath: string;
  requestId: string;
  accessMode: ChatAccessMode;
  locale: ChatLocale;
  signal: AbortSignal;
};

export type GoalWorkspaceRecoveryResult = {
  ok: boolean;
  content: string;
  mutationCommitted: boolean;
  phase?: GoalPhase;
};

/** Run one audited Chat recovery command in the Goal's existing prepared worktree. */
export async function recoverGoalWorkspace(input: GoalWorkspaceRecoveryInput): Promise<GoalWorkspaceRecoveryResult> {
  const fail = (content: string): GoalWorkspaceRecoveryResult => ({ ok: false, content, mutationCommitted: false });
  if (input.accessMode !== "full") return fail("Goal workspace recovery requires Full Access. No command was run.");
  if (!Number.isSafeInteger(input.runId) || input.runId < 1) return fail("A valid Goal runId is required.");

  let run;
  let task;
  try {
    run = input.database.getGoalRun(input.runId);
    task = input.database.getTask(run.taskId);
  } catch {
    return fail("The requested Goal or Task does not exist in this Maestro database.");
  }
  if (task.projectKey !== input.projectKey || input.projectKey === GLOBAL_CHAT_PROJECT_KEY) {
    return fail("Open the chat for the Goal's project before running recovery commands.");
  }
  if (!["waiting_provider", "blocked", "failed"].includes(run.status)) {
    return fail(`Goal #${input.runId} is ${run.status}; workspace recovery commands only run while a Goal is waiting or recoverable.`);
  }
  if (!task.worktreePath) return fail("This Goal has no prepared worktree. The project itself was not modified.");

  let workspacePath: string;
  try {
    workspacePath = fs.realpathSync(task.worktreePath);
    if (!fs.statSync(workspacePath).isDirectory()) return fail("The prepared Goal workspace is not a directory.");
    const projectPath = fs.realpathSync(input.registeredProjectPath);
    if (samePath(workspacePath, projectPath)) {
      return fail("The Goal points at the registered project directory instead of its isolated worktree; refusing to run there.");
    }
  } catch {
    return fail("The prepared Goal worktree is unavailable. Its path and files were left untouched.");
  }

  const plan = planChatCommand(input.command.trim(), "full");
  if (!plan || plan.blockedReason || !plan.executable) {
    return fail(plan?.blockedReason ?? "Provide one supported command without shell chaining or redirection.");
  }
  if (isLongRunningCommand(plan)) {
    return fail("Long-running project servers must use Maestro's managed process controls; use a bounded test or diagnostic command in this Goal workspace instead.");
  }

  const commandKey = plan.displayCommand.toLowerCase().replace(/\s+/g, " ").trim();
  const turnEvents = input.database.listEventsForTask(task.id, 500).filter((event) => (
    event.type === "goal.environment_recovery_command"
    && Number(event.metadata?.runId) === input.runId
    && event.metadata?.requestId === input.requestId
  ));
  const previousSameCommand = turnEvents
    .filter((event) => event.metadata?.commandKey === commandKey)
    .at(-1);
  if (previousSameCommand) {
    const laterSuccessfulRepair = turnEvents.some((event) => (
      event.id > previousSameCommand.id
      && event.metadata?.commandKey !== commandKey
      && event.metadata?.status === "completed"
    ));
    if (!laterSuccessfulRepair) {
      return fail(previousSameCommand.metadata?.status === "completed"
        ? "This exact command already succeeded in the current chat turn; use its stored evidence instead of repeating it."
        : "This exact command already failed in the current chat turn. Choose a materially different recovery command before retrying.");
    }
  }

  const workspaceFingerprintBefore = captureWorkspaceProgress(workspacePath);
  const commandEvidence = await executeChatCommand(
    plan,
    workspacePath,
    "full",
    input.signal,
    RECOVERY_COMMAND_TIMEOUT_MS
  );
  const workspaceFingerprintAfter = captureWorkspaceProgress(workspacePath);
  const eventText = formatChatCommandEvidence(commandEvidence, input.locale);
  input.database.addEvent({
    source: "chat",
    type: "goal.environment_recovery_command",
    text: eventText,
    taskId: task.id,
    metadata: {
      runId: input.runId,
      phase: run.currentPhase,
      requestId: input.requestId,
      command: plan.displayCommand,
      commandKey,
      status: commandEvidence.status,
      exitCode: commandEvidence.exitCode,
      durationMs: commandEvidence.durationMs,
      workspaceFingerprintBefore,
      workspaceFingerprintAfter,
      changedWorkspace: workspaceFingerprintBefore !== null
        && workspaceFingerprintAfter !== null
        && workspaceFingerprintBefore !== workspaceFingerprintAfter
    }
  });

  return {
    ok: commandEvidence.status === "completed",
    content: JSON.stringify({
      runId: input.runId,
      phase: run.currentPhase,
      evidence: commandEvidence,
      workspaceChanged: workspaceFingerprintBefore !== workspaceFingerprintAfter
    }, null, 2),
    // A failed command can still have partially installed packages or created
    // files, so never replay it automatically through another provider.
    mutationCommitted: commandEvidence.status === "completed" || commandEvidence.status === "failed",
    phase: run.currentPhase
  };
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
