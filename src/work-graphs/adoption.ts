export const WORK_GRAPH_ADOPTION_MODES = ["off", "shadow", "explicit"] as const;

export type WorkGraphAdoptionMode = typeof WORK_GRAPH_ADOPTION_MODES[number];

export type WorkGraphAdoptionReason =
  | "disabled_by_config"
  | "shadow_mode_records_only"
  | "explicit_request_required"
  | "explicit_request_recorded";

export type WorkGraphAdoptionDecision = {
  mode: WorkGraphAdoptionMode;
  decision: "off" | "shadow" | "explicit";
  reason: WorkGraphAdoptionReason;
  executionMode: "linear" | "work_graph";
  automaticFanOut: false;
  telemetry: WorkGraphAdoptionTelemetry;
};

export type WorkGraphAdoptionTelemetry = {
  candidate: boolean;
  estimatedWorkerNodes: number;
  complexitySignals: string[];
  taskTextLength: number;
  projectKey: string;
  trigger: "config" | "operator" | "task_metadata";
  isResume: boolean;
  currentPhase: string;
  stepCount: number;
};

export type WorkGraphAdoptionInput = {
  mode: WorkGraphAdoptionMode;
  taskText: string;
  projectKey: string;
  explicitRequest?: boolean;
  trigger?: WorkGraphAdoptionTelemetry["trigger"];
  isResume?: boolean;
  currentPhase?: string;
  stepCount?: number;
};

export function isWorkGraphAdoptionMode(value: string): value is WorkGraphAdoptionMode {
  return (WORK_GRAPH_ADOPTION_MODES as readonly string[]).includes(value);
}

export function decideWorkGraphAdoption(input: WorkGraphAdoptionInput): WorkGraphAdoptionDecision {
  const telemetry = buildTelemetry(input);

  if (input.mode === "off") {
    return {
      mode: "off",
      decision: "off",
      reason: "disabled_by_config",
      executionMode: "linear",
      automaticFanOut: false,
      telemetry
    };
  }

  if (input.mode === "shadow") {
    return {
      mode: "shadow",
      decision: "shadow",
      reason: "shadow_mode_records_only",
      executionMode: "linear",
      automaticFanOut: false,
      telemetry
    };
  }

  return {
    mode: "explicit",
    decision: input.explicitRequest ? "explicit" : "off",
    reason: input.explicitRequest ? "explicit_request_recorded" : "explicit_request_required",
    executionMode: input.explicitRequest ? "work_graph" : "linear",
    automaticFanOut: false,
    telemetry: {
      ...telemetry,
      trigger: input.explicitRequest ? input.trigger ?? "operator" : telemetry.trigger
    }
  };
}

function buildTelemetry(input: WorkGraphAdoptionInput): WorkGraphAdoptionTelemetry {
  const complexitySignals = detectComplexitySignals(input.taskText);
  const candidate = complexitySignals.length > 0;
  return {
    candidate,
    estimatedWorkerNodes: candidate ? Math.min(4, 2 + complexitySignals.length) : 1,
    complexitySignals,
    taskTextLength: input.taskText.length,
    projectKey: input.projectKey,
    trigger: input.trigger ?? "config",
    isResume: input.isResume ?? false,
    currentPhase: input.currentPhase ?? "planning",
    stepCount: input.stepCount ?? 0
  };
}

function detectComplexitySignals(taskText: string): string[] {
  const normalized = taskText.toLowerCase();
  const signals = new Set<string>();

  if (taskText.length >= 240) signals.add("long_task_text");
  if (/[;\n]|(?:\s+-\s+)/.test(taskText)) signals.add("multiple_clauses");
  if (/\b(refactor|migration|migrate|arquitet|architecture|schema|database|integration|integracao)\b/.test(normalized)) {
    signals.add("cross_module_change");
  }
  if (/\b(research|investigate|diagnose|audit|review|telemetry|observability|security|seguranca)\b/.test(normalized)) {
    signals.add("read_heavy_or_evidence_driven");
  }
  if (/\b(e2e|end-to-end|dashboard|telegram|github|provider|worker|work graph|multi-agent)\b/.test(normalized)) {
    signals.add("coordination_surface");
  }

  return [...signals].sort();
}
