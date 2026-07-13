import fs from "node:fs";
import path from "node:path";
import type { GoalStepRecord } from "../db.js";
import type { TokenRuntimeTelemetry } from "./compression.js";

export type RuntimeArtifactKeys = {
  rawOutputKey: string;
  compactHandoffKey: string;
  telemetryKey: string;
};

const RAW_OUTPUT_FILE = "provider-output.raw.txt";
const COMPACT_HANDOFF_FILE = "handoff.compact.txt";
const TELEMETRY_FILE = "token-runtime.json";

export function goalStepArtifactKey(step: Pick<GoalStepRecord, "id" | "runId" | "phase" | "provider">, fileName: string): string {
  return path.posix.join(goalStepArtifactPrefix(step), fileName);
}

export function rawOutputArtifactKey(step: Pick<GoalStepRecord, "id" | "runId" | "phase" | "provider">): string {
  return goalStepArtifactKey(step, RAW_OUTPUT_FILE);
}

export function goalStepArtifactPrefix(step: Pick<GoalStepRecord, "id" | "runId" | "phase" | "provider">): string {
  return path.posix.join(
    `goal-${step.runId}`,
    `step-${String(step.id).padStart(4, "0")}-${sanitizeSegment(step.phase)}-${sanitizeSegment(step.provider)}`
  );
}

export function writeGoalStepRuntimeArtifacts(input: {
  artifactsRoot: string;
  step: Pick<GoalStepRecord, "id" | "runId" | "phase" | "provider">;
  rawOutput: string;
  compactHandoff: string;
  telemetry: TokenRuntimeTelemetry;
}): RuntimeArtifactKeys {
  const prefix = goalStepArtifactPrefix(input.step);
  const dir = path.join(input.artifactsRoot, ...prefix.split("/"));
  fs.mkdirSync(dir, { recursive: true });

  const keys = {
    rawOutputKey: path.posix.join(prefix, RAW_OUTPUT_FILE),
    compactHandoffKey: path.posix.join(prefix, COMPACT_HANDOFF_FILE),
    telemetryKey: path.posix.join(prefix, TELEMETRY_FILE)
  };
  fs.writeFileSync(path.join(dir, RAW_OUTPUT_FILE), input.rawOutput, "utf8");
  fs.writeFileSync(path.join(dir, COMPACT_HANDOFF_FILE), input.compactHandoff, "utf8");
  fs.writeFileSync(path.join(dir, TELEMETRY_FILE), JSON.stringify(input.telemetry, null, 2), "utf8");
  return keys;
}

export function recoverGoalStepRawOutput(artifactsRoot: string, step: Pick<GoalStepRecord, "id" | "runId" | "phase" | "provider">): string | null {
  const filePath = path.join(artifactsRoot, ...goalStepArtifactKey(step, RAW_OUTPUT_FILE).split("/"));
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function sanitizeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}
