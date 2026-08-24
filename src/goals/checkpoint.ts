import type {
  GoalCheckpointInput,
  GoalCheckpointRecord,
  GoalPhase,
  GoalTestRun
} from "../db.js";
import { runGit } from "../git.js";

export type { GoalTestRun };

export type CaptureGoalCheckpointInput = {
  runId: number;
  stepId: number;
  phase: GoalPhase;
  provider: string;
  interrupted: boolean;
  summary: string;
  objective?: string;
  done?: string[];
  decisions?: string[];
  testsRun?: GoalTestRun[];
  knownFailures?: string[];
  remaining?: string[];
  workspacePath: string;
  workspaceFingerprint: string | null;
  artifactKeys: string[];
  output?: string;
  error?: string | null;
  previousCheckpoint?: GoalCheckpointRecord | null;
};

export function captureGoalCheckpoint(input: CaptureGoalCheckpointInput): GoalCheckpointInput {
  const extracted = extractSemanticContext({
    summary: input.summary,
    output: input.output,
    error: input.error,
    phase: input.phase,
    provider: input.provider,
    interrupted: input.interrupted,
    previousCheckpoint: input.previousCheckpoint
  });

  const objective = input.objective ?? input.previousCheckpoint?.objective ?? "";
  const done = input.done ?? (extracted.done.length > 0 ? extracted.done : (input.summary ? [input.summary] : []));
  const decisions = input.decisions ?? extracted.decisions;
  const testsRun = input.testsRun ?? extracted.testsRun;
  const knownFailures = input.knownFailures ?? extracted.knownFailures;
  const remaining = input.remaining ?? extracted.remaining;

  return {
    runId: input.runId,
    stepId: input.stepId,
    phase: input.phase,
    provider: input.provider,
    status: input.interrupted ? "interrupted" : "completed",
    summary: input.summary,
    objective,
    done: deduplicateStrings(done),
    decisions: deduplicateStrings(decisions),
    testsRun: deduplicateTestRuns(testsRun),
    knownFailures: deduplicateStrings(knownFailures),
    remaining: deduplicateStrings(remaining),
    workspaceFingerprint: input.workspaceFingerprint,
    changedFiles: listWorkspaceChanges(input.workspacePath),
    artifactKeys: [...new Set(input.artifactKeys)]
  };
}

export function extractSemanticContext(params: {
  summary?: string;
  output?: string;
  error?: string | null;
  phase: GoalPhase;
  provider: string;
  interrupted: boolean;
  previousCheckpoint?: GoalCheckpointRecord | null;
}): {
  done: string[];
  decisions: string[];
  testsRun: GoalTestRun[];
  knownFailures: string[];
  remaining: string[];
} {
  const prev = params.previousCheckpoint;
  const done: string[] = prev?.done ? [...prev.done] : [];
  const decisions: string[] = prev?.decisions ? [...prev.decisions] : [];
  const testsRun: GoalTestRun[] = prev?.testsRun ? [...prev.testsRun] : [];
  const knownFailures: string[] = prev?.knownFailures ? [...prev.knownFailures] : [];
  const remaining: string[] = [];

  if (params.error) {
    knownFailures.push(params.error);
  }

  const text = [params.summary, params.output].filter(Boolean).join("\n");
  if (text) {
    const parsed = parseStructuredHandoffText(text);
    done.push(...parsed.done);
    decisions.push(...parsed.decisions);
    testsRun.push(...parsed.testsRun);
    knownFailures.push(...parsed.knownFailures);
    remaining.push(...parsed.remaining);
  }

  if (params.interrupted && remaining.length === 0) {
    remaining.push(`Resume the ${params.phase} phase through ${params.provider}`);
  }

  return {
    done: deduplicateStrings(done),
    decisions: deduplicateStrings(decisions),
    testsRun: deduplicateTestRuns(testsRun),
    knownFailures: deduplicateStrings(knownFailures),
    remaining: deduplicateStrings(remaining)
  };
}

export function formatCheckpointForResume(checkpoint: GoalCheckpointRecord | null): string | undefined {
  if (!checkpoint) return undefined;

  const files = checkpoint.changedFiles && checkpoint.changedFiles.length > 0
    ? checkpoint.changedFiles.map((file) => `- ${file}`).join("\n")
    : "- no files detected";

  const artifacts = checkpoint.artifactKeys && checkpoint.artifactKeys.length > 0
    ? checkpoint.artifactKeys.map((key) => `- artifact:${key}`).join("\n")
    : "- no artifacts";

  const doneList = checkpoint.done && checkpoint.done.length > 0
    ? checkpoint.done.map((item) => `- ${item}`).join("\n")
    : "- no items recorded";

  const decisionsList = checkpoint.decisions && checkpoint.decisions.length > 0
    ? checkpoint.decisions.map((item) => `- ${item}`).join("\n")
    : "- no decisions recorded";

  const testsList = checkpoint.testsRun && checkpoint.testsRun.length > 0
    ? checkpoint.testsRun.map((t) => `- [${t.command}]: ${t.result}`).join("\n")
    : "- no tests recorded";

  const failuresList = checkpoint.knownFailures && checkpoint.knownFailures.length > 0
    ? checkpoint.knownFailures.map((item) => `- ${item}`).join("\n")
    : "- no failures recorded";

  const remainingList = checkpoint.remaining && checkpoint.remaining.length > 0
    ? checkpoint.remaining.map((item) => `- ${item}`).join("\n")
    : "- no pending work recorded";

  const lines = [
    `Persistent checkpoint #${checkpoint.id} (${checkpoint.status})`,
    `Previous provider: ${checkpoint.provider}`,
    `Previous phase: ${checkpoint.phase}`,
    ...(checkpoint.objective ? [`Objective: ${checkpoint.objective}`] : []),
    `Summary: ${checkpoint.summary}`,
    "Completed work:",
    doneList,
    "Decisions made:",
    decisionsList,
    "Tests run:",
    testsList,
    "Known failures:",
    failuresList,
    "Remaining work:",
    remainingList,
    "Files present in the workspace:",
    files,
    "Persisted evidence:",
    artifacts,
    "Continue from the current workspace. Do not revert or redo valid work without concrete evidence."
  ];

  return lines.join("\n");
}

function parseStructuredHandoffText(text: string): {
  done: string[];
  decisions: string[];
  testsRun: GoalTestRun[];
  knownFailures: string[];
  remaining: string[];
} {
  const done: string[] = [];
  const decisions: string[] = [];
  const testsRun: GoalTestRun[] = [];
  const knownFailures: string[] = [];
  const remaining: string[] = [];

  let currentSection: "done" | "decisions" | "tests" | "failures" | "remaining" | null = null;

  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^(?:o que foi realizado|concluido|items concluidos|realizado|done)[:\s]/i.test(line)) {
      currentSection = "done";
      continue;
    }
    if (/^(?:decisoes|decisao|decisions|decisions made)[:\s]/i.test(line)) {
      currentSection = "decisions";
      continue;
    }
    if (/^(?:testes|tests|testes executados|tests run)[:\s]/i.test(line)) {
      currentSection = "tests";
      continue;
    }
    if (/^(?:falhas|failures|known failures|falhas conhecidas|erros)[:\s]/i.test(line)) {
      currentSection = "failures";
      continue;
    }
    if (/^(?:trabalho restante|remaining|pending|pendentes|proximas etapas)[:\s]/i.test(line)) {
      currentSection = "remaining";
      continue;
    }

    if (currentSection && /^[-*•\d+.]\s+/.test(line)) {
      const content = line.replace(/^[-*•\d+.]\s+/, "").trim();
      if (!content) continue;

      if (currentSection === "done") {
        done.push(content);
      } else if (currentSection === "decisions") {
        decisions.push(content);
      } else if (currentSection === "tests") {
        const match = content.match(/^\[?([^\]]+)\]?:\s*(.+)$/) || content.match(/^(.+?)\s*->\s*(.+)$/);
        if (match) {
          testsRun.push({ command: match[1].trim(), result: match[2].trim() });
        } else {
          testsRun.push({ command: content, result: "executado" });
        }
      } else if (currentSection === "failures") {
        knownFailures.push(content);
      } else if (currentSection === "remaining") {
        remaining.push(content);
      }
    }
  }

  return { done, decisions, testsRun, knownFailures, remaining };
}

function deduplicateStrings(arr: string[]): string[] {
  return [...new Set(arr.map((s) => s.trim()))].filter(Boolean);
}

function deduplicateTestRuns(arr: GoalTestRun[]): GoalTestRun[] {
  const seen = new Set<string>();
  const res: GoalTestRun[] = [];
  for (const t of arr) {
    const key = `${t.command}::${t.result}`;
    if (!seen.has(key)) {
      seen.add(key);
      res.push(t);
    }
  }
  return res;
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
