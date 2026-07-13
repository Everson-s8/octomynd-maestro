import type { GoalPhase, GoalStepRecord, GoalStepStatus } from "../db.js";
import { redactSensitiveText, truncateForDisplay } from "../security/redaction.js";
import { rtkDetectionForTelemetry } from "./rtk.js";
import type { RtkDetection } from "./rtk.js";
import { TokenUsageEstimate, compareTokenUsage, estimateTokenUsage } from "./tokens.js";

export type RuntimeCommandName =
  | "git.diff"
  | "git.status"
  | "git.log"
  | "rg"
  | "test"
  | "provider.output";

export type RuntimeCommandMetric = {
  command: RuntimeCommandName;
  baseline: TokenUsageEstimate;
  compact: TokenUsageEstimate;
  evidenceLines: number;
};

export type TokenRuntimeAbTest = {
  control: {
    name: "legacy-output-slice";
    bytes: number;
    tokens: number;
  };
  treatment: {
    name: "token-efficient-compact";
    bytes: number;
    tokens: number;
  };
  savedBytes: number;
  savedTokens: number;
  savingsRatio: number;
  quality: {
    rawArtifactAvailable: boolean;
    failureOutputPreserved: boolean;
    errorEvidenceLines: number;
    evidenceLines: number;
  };
};

export type TokenRuntimeTelemetry = {
  provider: string;
  phase: GoalPhase;
  status: GoalStepStatus;
  adapter: "internal" | "disabled";
  rtk: ReturnType<typeof rtkDetectionForTelemetry>;
  baseline: TokenUsageEstimate;
  compact: TokenUsageEstimate;
  savedBytes: number;
  savedTokens: number;
  savingsRatio: number;
  commands: RuntimeCommandMetric[];
  abTest: TokenRuntimeAbTest;
};

export type TokenEfficientHandoffStep = {
  stepId: number;
  phase: GoalPhase;
  provider: string;
  status: GoalStepStatus;
  summary: string;
  compactOutput: string;
  rawOutputArtifact: string | null;
  telemetry: TokenRuntimeTelemetry;
};

export type StepCompressionInput = {
  step: Pick<GoalStepRecord, "id" | "phase" | "provider" | "status" | "summary" | "output" | "error"> & {
    runId?: number;
  };
  rtk: RtkDetection;
  rawOutputArtifact?: string | null;
  enabled?: boolean;
};

export type StepCompressionResult = {
  handoff: TokenEfficientHandoffStep;
  compactOutput: string;
  telemetry: TokenRuntimeTelemetry;
};

type CommandDetector = {
  command: RuntimeCommandName;
  detect: RegExp[];
  evidence: RegExp[];
};

const LEGACY_OUTPUT_SLICE_CHARS = 2_000;
const SUCCESS_COMPACT_MAX_CHARS = 1_200;
const FAILURE_COMPACT_MAX_CHARS = 4_000;
const LINE_MAX_CHARS = 220;

const ERROR_LINE = /\b(error|failed|failure|exception|assertion|timeout|quota|auth|panic|fatal|cannot|expected|received|denied|blocked)\b/i;
const REVIEW_DECISION_LINE = /\bFINAL_REVIEW_DECISION:\s*(approved|changes_requested)\b/i;

const COMMAND_DETECTORS: CommandDetector[] = [
  {
    command: "git.diff",
    detect: [/\bgit\s+diff\b/i, /^diff --git\b/m, /^@@\s/m, /^\+\+\+\s/m, /^---\s/m],
    evidence: [/^diff --git\b/, /^@@\s/, /^\+\+\+\s/, /^---\s/, /^[+-](?![+-])\S?/]
  },
  {
    command: "git.status",
    detect: [/\bgit\s+status\b/i, /\bOn branch\b/i, /\bChanges (not )?staged\b/i, /^[ MARCUD?!]{1,2}\s+\S+/m],
    evidence: [/^[ MARCUD?!]{1,2}\s+\S+/, /\bOn branch\b/i, /\bChanges (not )?staged\b/i, /\bnothing to commit\b/i]
  },
  {
    command: "git.log",
    detect: [/\bgit\s+log\b/i, /^commit\s+[a-f0-9]{7,40}\b/im, /^Author:\s/im, /^Date:\s/im],
    evidence: [/^commit\s+[a-f0-9]{7,40}\b/i, /^Author:\s/i, /^Date:\s/i, /^\s{4}\S/]
  },
  {
    command: "rg",
    detect: [/\brg\b/i, /\bripgrep\b/i, /^[^:\n]+:\d+:\d?:?.+/m],
    evidence: [/^[^:\n]+:\d+:\d?:?.+/, /\bno matches\b/i, /\bmatches\b/i]
  },
  {
    command: "test",
    detect: [
      /\b(npm test|npx vitest|vitest|pytest|cargo test|go test|pnpm test|yarn test)\b/i,
      /\b(PASS|FAIL|FAILED|passed|failed)\b/,
      /\b(Test Files|Tests|Snapshots|assertion|AssertionError|TypeError)\b/i
    ],
    evidence: [
      /\b(PASS|FAIL|FAILED|passed|failed)\b/,
      /\b(Test Files|Tests|Snapshots|assertion|AssertionError|TypeError)\b/i,
      /^\s*(Expected|Received):\s/i
    ]
  }
];

export function compressStepOutput(input: StepCompressionInput): StepCompressionResult {
  const summary = redactSensitiveText(input.step.summary).trim();
  const output = redactSensitiveText(input.step.output || "");
  const error = input.step.error ? redactSensitiveText(input.step.error) : null;
  const enabled = input.enabled !== false;
  const rawArtifact = input.rawOutputArtifact ?? null;
  const detectedCommands = detectCommands([output, error ?? "", summary].join("\n"));
  const commandNames = detectedCommands.length > 0 ? detectedCommands : ["provider.output" as const];
  const compactOutput = enabled
    ? buildCompactOutput({
      output,
      error,
      status: input.step.status,
      commandNames,
      rawArtifact
    })
    : legacyOutputSlice(output);
  const baseline = estimateTokenUsage(output);
  const compact = estimateTokenUsage([summary, compactOutput].filter(Boolean).join("\n"));
  const comparison = compareTokenUsage(output, [summary, compactOutput].filter(Boolean).join("\n"));
  const legacyComparison = compareTokenUsage(
    [summary, legacyOutputSlice(output)].filter(Boolean).join("\n"),
    [summary, compactOutput].filter(Boolean).join("\n")
  );
  const errorEvidenceLines = error ? countMeaningfulLines(error) : countLinesMatching(output, ERROR_LINE);
  const evidenceLines = countCompactEvidenceLines(compactOutput);
  const telemetry: TokenRuntimeTelemetry = {
    provider: input.step.provider,
    phase: input.step.phase,
    status: input.step.status,
    adapter: enabled ? "internal" : "disabled",
    rtk: rtkDetectionForTelemetry(input.rtk),
    baseline,
    compact,
    savedBytes: comparison.savedBytes,
    savedTokens: comparison.savedTokens,
    savingsRatio: comparison.savingsRatio,
    commands: commandNames.map((command) => commandMetric(command, output, compactOutput)),
    abTest: {
      control: {
        name: "legacy-output-slice",
        ...estimateTokenUsage([summary, legacyOutputSlice(output)].filter(Boolean).join("\n"))
      },
      treatment: {
        name: "token-efficient-compact",
        ...compact
      },
      savedBytes: legacyComparison.savedBytes,
      savedTokens: legacyComparison.savedTokens,
      savingsRatio: legacyComparison.savingsRatio,
      quality: {
        rawArtifactAvailable: Boolean(rawArtifact),
        failureOutputPreserved: input.step.status !== "failed" || Boolean(rawArtifact),
        errorEvidenceLines,
        evidenceLines
      }
    }
  };
  const handoff: TokenEfficientHandoffStep = {
    stepId: input.step.id,
    phase: input.step.phase,
    provider: input.step.provider,
    status: input.step.status,
    summary,
    compactOutput,
    rawOutputArtifact: rawArtifact,
    telemetry
  };
  return { handoff, compactOutput, telemetry };
}

export function formatTokenEfficientPreviousSteps(steps: TokenEfficientHandoffStep[]): string {
  if (steps.length === 0) return "Nenhuma etapa anterior.";
  return steps.map((step) => [
    `- ${step.phase}/${step.provider}/${step.status}: ${step.summary || "sem resumo"}`,
    `  compacto: ${indentDetails(step.compactOutput || "sem detalhes")}`
  ].join("\n")).join("\n");
}

export function formatLegacyPreviousSteps(steps: GoalStepRecord[]): string {
  if (steps.length === 0) return "Nenhuma etapa anterior.";
  return steps.map((step) => (
    `- ${step.phase}/${step.provider}/${step.status}: ${step.summary}\n`
    + `  detalhes: ${step.output.slice(0, LEGACY_OUTPUT_SLICE_CHARS) || "sem detalhes"}`
  )).join("\n");
}

function buildCompactOutput(input: {
  output: string;
  error: string | null;
  status: GoalStepStatus;
  commandNames: RuntimeCommandName[];
  rawArtifact: string | null;
}): string {
  const maxChars = input.status === "failed" || input.status === "blocked"
    ? FAILURE_COMPACT_MAX_CHARS
    : SUCCESS_COMPACT_MAX_CHARS;
  const sections: string[] = [];
  if (input.error) {
    sections.push("erros:");
    sections.push(...firstMeaningfulLines(input.error, 10).map((line) => `- ${line}`));
  }

  const evidence = selectEvidenceLines(input.output, input.commandNames, input.status);
  if (evidence.length > 0) {
    sections.push("evidencias:");
    sections.push(...evidence.map((line) => `- ${line}`));
  }

  if (input.rawArtifact) sections.push(`raw: artifact:${input.rawArtifact}`);
  const compact = sections.join("\n").trim();
  return truncateForDisplay(compact || firstMeaningfulLines(input.output, 6).join("\n") || "sem detalhes", maxChars);
}

function detectCommands(text: string): RuntimeCommandName[] {
  return COMMAND_DETECTORS
    .filter((detector) => detector.detect.some((pattern) => test(pattern, text)))
    .map((detector) => detector.command);
}

function selectEvidenceLines(
  output: string,
  commandNames: RuntimeCommandName[],
  status: GoalStepStatus
): string[] {
  const maxLines = status === "failed" || status === "blocked" ? 36 : 16;
  const detectors = COMMAND_DETECTORS.filter((detector) => commandNames.includes(detector.command));
  const evidencePatterns = [
    ERROR_LINE,
    REVIEW_DECISION_LINE,
    ...detectors.flatMap((detector) => detector.evidence)
  ];
  const selected = outputLines(output).filter((line) => evidencePatterns.some((pattern) => test(pattern, line)));
  const fallback = selected.length > 0 ? selected : firstMeaningfulLines(output, status === "failed" ? 12 : 6);
  return uniqueLines(fallback).slice(0, maxLines);
}

function commandMetric(command: RuntimeCommandName, output: string, compactOutput: string): RuntimeCommandMetric {
  const detector = COMMAND_DETECTORS.find((item) => item.command === command);
  const rawLines = detector
    ? outputLines(output).filter((line) => detector.detect.some((pattern) => test(pattern, line)) || detector.evidence.some((pattern) => test(pattern, line)))
    : outputLines(output);
  const compactLines = detector
    ? outputLines(compactOutput).filter((line) => detector.evidence.some((pattern) => test(pattern, line)) || test(ERROR_LINE, line))
    : outputLines(compactOutput);
  const baselineText = rawLines.length > 0 ? rawLines.join("\n") : output;
  const compactText = compactLines.length > 0 ? compactLines.join("\n") : compactOutput;
  return {
    command,
    baseline: estimateTokenUsage(baselineText),
    compact: estimateTokenUsage(compactText),
    evidenceLines: compactLines.length
  };
}

function legacyOutputSlice(output: string): string {
  return output.slice(0, LEGACY_OUTPUT_SLICE_CHARS) || "sem detalhes";
}

function firstMeaningfulLines(text: string, maxLines: number): string[] {
  return outputLines(text).slice(0, maxLines);
}

function outputLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => truncateForDisplay(line.trim(), LINE_MAX_CHARS))
    .filter(Boolean);
}

function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    result.push(line);
  }
  return result;
}

function indentDetails(details: string): string {
  return details.replace(/\n/g, "\n    ");
}

function countMeaningfulLines(text: string): number {
  return outputLines(text).length;
}

function countLinesMatching(text: string, pattern: RegExp): number {
  return outputLines(text).filter((line) => test(pattern, line)).length;
}

function countCompactEvidenceLines(text: string): number {
  return outputLines(text).filter((line) => line.startsWith("- ")).length;
}

function test(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}
