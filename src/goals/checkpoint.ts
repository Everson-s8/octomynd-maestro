import type {
  GoalCheckpointInput,
  GoalCheckpointRecord,
  GoalPhase
} from "../db.js";
import { runGit } from "../git.js";

export type CaptureGoalCheckpointInput = {
  runId: number;
  stepId: number;
  phase: GoalPhase;
  provider: string;
  interrupted: boolean;
  summary: string;
  workspacePath: string;
  workspaceFingerprint: string | null;
  artifactKeys: string[];
};

export function captureGoalCheckpoint(input: CaptureGoalCheckpointInput): GoalCheckpointInput {
  return {
    runId: input.runId,
    stepId: input.stepId,
    phase: input.phase,
    provider: input.provider,
    status: input.interrupted ? "interrupted" : "completed",
    summary: input.summary,
    workspaceFingerprint: input.workspaceFingerprint,
    changedFiles: listWorkspaceChanges(input.workspacePath),
    artifactKeys: [...new Set(input.artifactKeys)]
  };
}

export function formatCheckpointForResume(checkpoint: GoalCheckpointRecord | null): string | undefined {
  if (!checkpoint) return undefined;
  const files = checkpoint.changedFiles.length > 0
    ? checkpoint.changedFiles.map((file) => `- ${file}`).join("\n")
    : "- nenhum arquivo detectado";
  const artifacts = checkpoint.artifactKeys.length > 0
    ? checkpoint.artifactKeys.map((key) => `- artifact:${key}`).join("\n")
    : "- nenhum artifact";
  return [
    `Checkpoint persistente #${checkpoint.id} (${checkpoint.status})`,
    `Provider anterior: ${checkpoint.provider}`,
    `Fase anterior: ${checkpoint.phase}`,
    `Resumo: ${checkpoint.summary}`,
    "Arquivos presentes no workspace:",
    files,
    "Evidencias persistidas:",
    artifacts,
    "Continue a partir do workspace atual. Nao reverta nem refaca trabalho valido sem evidencia concreta."
  ].join("\n");
}

function listWorkspaceChanges(workspacePath: string): string[] {
  const tracked = runGit(["diff", "--name-only", "-z", "HEAD"], workspacePath);
  const untracked = runGit(["ls-files", "--others", "--exclude-standard", "-z"], workspacePath);
  if (!tracked.ok && !untracked.ok) return [];
  return [...new Set([
    ...splitNull(tracked.ok ? tracked.stdout : ""),
    ...splitNull(untracked.ok ? untracked.stdout : "")
  ])].sort();
}

function splitNull(value: string): string[] {
  return value.split("\0").map((item) => item.trim()).filter(Boolean);
}
