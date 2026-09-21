import type { AgentReasoningEffort } from "../agents/types.js";

export const CHAT_AGENT_TOOLS = [
  "inspect_project",
  "project_state",
  "read_memory",
  "run_command",
  "governed_action"
] as const;

export type ChatAgentToolName = typeof CHAT_AGENT_TOOLS[number];

export type ChatAgentBudget = {
  maxIterations: number;
  maxToolCalls: number;
};

export type ChatAgentProgress = {
  phase: "thinking" | "tool" | "finished" | "cancelled" | "budget_exhausted";
  iteration: number;
  maxIterations: number;
  toolCalls: number;
  maxToolCalls: number;
  toolName: ChatAgentToolName | null;
  detail: string;
};

export type ChatAgentToolResult = {
  ok: boolean;
  content: string;
  /** A governed action that needs confirmation in Standard/Approval mode. */
  pendingAction?: unknown;
  /** True when the tool completed a side effect that must not be replayed on fallback. */
  mutationCommitted?: boolean;
};

export type ChatAgentTurn =
  | { type: "final"; response: string }
  | { type: "tool_call"; name: ChatAgentToolName; arguments: Record<string, unknown>; rationale?: string }
  | { type: "invalid"; reason: string };

export type ChatAgentLoopResult = {
  response: string;
  providerId: string;
  model: string | null;
  iterations: number;
  toolCalls: number;
  toolsUsed: ChatAgentToolName[];
  stopReason: "model_finished" | "budget_exhausted" | "cancelled";
  pendingActions: unknown[];
  mutationCommitted: boolean;
};

export type ChatAgentLoopInput = {
  userMessage: string;
  initialPrompt: string;
  providerId: string;
  model: string | null;
  effort: AgentReasoningEffort | null;
  budget: ChatAgentBudget;
  signal: AbortSignal;
  invoke: (input: {
    prompt: string;
    iteration: number;
    model: string | null;
    effort: AgentReasoningEffort | null;
    signal: AbortSignal;
  }) => Promise<{ output: string; structuredPayload?: Record<string, unknown> | null }>;
  executeTool: (input: {
    name: ChatAgentToolName;
    arguments: Record<string, unknown>;
    iteration: number;
    signal: AbortSignal;
  }) => Promise<ChatAgentToolResult>;
  onProgress?: (progress: ChatAgentProgress) => void;
};

/**
 * The provider chooses whether to stop or ask for another tool. The loop only
 * enforces an explicit work budget and cancellation; it never uses a wall
 * clock as a proxy for completion.
 */
export async function runChatAgentLoop(input: ChatAgentLoopInput): Promise<ChatAgentLoopResult> {
  const budget = normalizeBudget(input.budget);
  const promptParts: string[] = [];
  let iterations = 0;
  let toolCalls = 0;
  const toolsUsed: ChatAgentToolName[] = [];
  const pendingActions: unknown[] = [];
  let mutationCommitted = false;

  while (iterations < budget.maxIterations) {
    throwIfAborted(input.signal);
    iterations += 1;
    input.onProgress?.({
      phase: "thinking",
      iteration: iterations,
      maxIterations: budget.maxIterations,
      toolCalls,
      maxToolCalls: budget.maxToolCalls,
      toolName: null,
      detail: `Provider reasoning iteration ${iterations}/${budget.maxIterations}.`
    });

    const result = await input.invoke({
      prompt: buildTurnPrompt(input.initialPrompt, promptParts),
      iteration: iterations,
      model: input.model,
      effort: input.effort,
      signal: input.signal
    });
    throwIfAborted(input.signal);

    const turn = parseChatAgentTurn(result.structuredPayload, result.output);
    if (turn.type === "invalid") {
      promptParts.push(`MODEL OUTPUT INVALID: ${turn.reason}\nThe previous provider output was not a valid Maestro turn. Return exactly one JSON object with type=tool_call or type=final; do not wrap it in prose.`);
      input.onProgress?.({
        phase: "thinking",
        iteration: iterations,
        maxIterations: budget.maxIterations,
        toolCalls,
        maxToolCalls: budget.maxToolCalls,
        toolName: null,
        detail: "Provider returned an invalid structured turn; requesting a corrected turn."
      });
      continue;
    }
    if (turn.type === "final") {
      input.onProgress?.({
        phase: "finished",
        iteration: iterations,
        maxIterations: budget.maxIterations,
        toolCalls,
        maxToolCalls: budget.maxToolCalls,
        toolName: null,
        detail: "Provider declared the work complete."
      });
      return {
        response: turn.response,
        providerId: input.providerId,
        model: input.model,
        iterations,
        toolCalls,
        toolsUsed,
        stopReason: "model_finished",
        pendingActions,
        mutationCommitted
      };
    }

    if (toolCalls >= budget.maxToolCalls) {
      input.onProgress?.({
        phase: "budget_exhausted",
        iteration: iterations,
        maxIterations: budget.maxIterations,
        toolCalls,
        maxToolCalls: budget.maxToolCalls,
        toolName: turn.name,
        detail: "The tool-call budget was reached before the provider finished."
      });
      return budgetResult(input, iterations, toolCalls, toolsUsed, pendingActions, mutationCommitted);
    }

    toolCalls += 1;
    toolsUsed.push(turn.name);
    input.onProgress?.({
      phase: "tool",
      iteration: iterations,
      maxIterations: budget.maxIterations,
      toolCalls,
      maxToolCalls: budget.maxToolCalls,
      toolName: turn.name,
      detail: turn.rationale || `Running ${turn.name}.`
    });
    const toolResult = await input.executeTool({
      name: turn.name,
      arguments: turn.arguments,
      iteration: iterations,
      signal: input.signal
    });
    throwIfAborted(input.signal);
    mutationCommitted ||= toolResult.mutationCommitted === true;
    if (toolResult.pendingAction !== undefined) pendingActions.push(toolResult.pendingAction);
    promptParts.push(`TOOL CALL ${toolCalls}: ${turn.name}\nARGUMENTS:\n${safeJson(turn.arguments)}\nTOOL RESULT:\n${truncateToolResult(toolResult.content)}\n\nContinue investigating if evidence is still missing. When the work is complete, return a final response JSON object. Do not repeat a tool call unless it adds new evidence.`);
  }

  input.onProgress?.({
    phase: "budget_exhausted",
    iteration: iterations,
    maxIterations: budget.maxIterations,
    toolCalls,
    maxToolCalls: budget.maxToolCalls,
    toolName: null,
    detail: "The reasoning iteration budget was reached before the provider finished."
  });
  return budgetResult(input, iterations, toolCalls, toolsUsed, pendingActions, mutationCommitted);
}

export function parseChatAgentTurn(
  structuredPayload: Record<string, unknown> | null | undefined,
  output: string
): ChatAgentTurn {
  const candidate = structuredPayload && typeof structuredPayload === "object"
    ? structuredPayload
    : parseJsonObject(output);
  if (candidate) {
    const type = candidate.type ?? candidate.kind;
    if (type === "tool_call" || type === "tool") {
      const name = candidate.name ?? candidate.tool;
      if (isToolName(name)) {
        const args = candidate.arguments ?? candidate.input ?? {};
        return {
          type: "tool_call",
          name,
          arguments: isRecord(args) ? args : {},
          rationale: typeof candidate.rationale === "string" ? candidate.rationale : undefined
        };
      }
      return { type: "invalid", reason: "The provider requested an unknown or malformed tool." };
    }
    if (type === "final" || type === "answer" || type === "done") {
      const response = candidate.response ?? candidate.answer ?? candidate.message ?? candidate.output;
      if (typeof response === "string" && response.trim()) return { type: "final", response: response.trim() };
      return { type: "invalid", reason: "The provider returned a final turn without a non-empty response." };
    }
    return { type: "invalid", reason: "The provider returned JSON without a supported turn type." };
  }
  const text = output.trim();
  if (/^```(?:json)?\s*[\s\S]*```$/i.test(text) || /^\s*\{/.test(text) || /"(?:type|kind|tool_call|tool)"\s*:/.test(text)) {
    return { type: "invalid", reason: "The provider output looked like JSON but could not be parsed." };
  }
  return { type: "final", response: text || "The provider returned an empty response." };
}

function budgetResult(
  input: ChatAgentLoopInput,
  iterations: number,
  toolCalls: number,
  toolsUsed: ChatAgentToolName[],
  pendingActions: unknown[],
  mutationCommitted = false
): ChatAgentLoopResult {
  return {
    response: "I reached the configured reasoning budget before the work was complete. The partial evidence is preserved; continue the conversation to resume.",
    providerId: input.providerId,
    model: input.model,
    iterations,
    toolCalls,
    toolsUsed,
    stopReason: "budget_exhausted",
    pendingActions,
    mutationCommitted
  };
}

function normalizeBudget(value: ChatAgentBudget): ChatAgentBudget {
  return {
    maxIterations: Math.max(1, Math.min(32, Math.floor(value.maxIterations))),
    maxToolCalls: Math.max(0, Math.min(64, Math.floor(value.maxToolCalls)))
  };
}

function parseJsonObject(output: string): Record<string, unknown> | null {
  const trimmed = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isToolName(value: unknown): value is ChatAgentToolName {
  return typeof value === "string" && (CHAT_AGENT_TOOLS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2).slice(0, 12_000);
  } catch {
    return "{}";
  }
}

function buildTurnPrompt(initialPrompt: string, toolTurns: string[]): string {
  const boundedTurns = toolTurns.slice(-8).join("\n\n");
  const base = initialPrompt.slice(0, 48_000);
  return boundedTurns ? `${base}\n\nTOOL TRANSCRIPT (bounded):\n${boundedTurns}` : base;
}

function truncateToolResult(value: string): string {
  const text = value.trim();
  if (text.length <= 12_000) return text;
  return `${text.slice(0, 12_000)}\n...[tool result truncated]`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error("Chat agent loop cancelled.");
    error.name = "AbortError";
    throw error;
  }
}
