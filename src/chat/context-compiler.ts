import type {
  ChatEvidenceMemoryFact,
  OperationalChatMessageRecord
} from "./types.js";

/**
 * The chat transcript is an immutable source of truth. This module builds a
 * smaller working set for each turn, following Hermes' separation between
 * transcript, rolling context and the current request.
 */
export type CompiledChatContext = {
  workingMemory: {
    objective: string | null;
    requirements: string[];
    decisions: string[];
    constraints: string[];
    openQuestions: string[];
    digest: string[];
  };
  recentMessages: OperationalChatMessageRecord[];
  promptText: string;
};

type ContextMessage = Pick<OperationalChatMessageRecord, "senderRole" | "messageText"> & Partial<Pick<OperationalChatMessageRecord, "id">>;

const META_MESSAGE = /^(?:eu\s+)?(?:quero|preciso|pode|por favor)?\s*(?:crie|criar|abra|abrir)\s+(?:uma\s+)?(?:task|tarefa)\b/i;
const HISTORY_MESSAGE = /^(?:sim,?\s+)?(?:consigo|posso)\s+(?:recuperar|conversar)\s+(?:o\s+)?hist[oó]rico/i;
const GENERIC_STATUS = /^nenhuma\s+task\s+parada/i;
const GENERIC_FOLLOWUP = /^mensagem\s+de\s+(?:acompanhamento|follow[- ]?up)\b/i;
const SYNTHESIS_MARKERS = /\b(?:objetivo|escopo|problema|sistema|implementar|funcionalidade|requisito|gest[aã]o|d[ií]vida|plano|vers[aã]o)\b/i;
const INCIDENT_MARKERS = /\b(?:waiting for provider|aguardando provider|permission denied|permiss[aã]o negada|no output produced|sem saida|provider failed|provider falhou|task blocked|task bloqueada|goal blocked|goal bloqueado|erro|falha|failed|blocked|travou|parou)\b/i;
const IMPLEMENTATION_MARKERS = /\b(?:implement|corrig|consert|resolver|ajust|adicion|remov|refator|constru|criar|crie|melhor|fix|repair|change|modify|build|develop|desenvolv)\w*\b/i;

export function compileOperationalChatContext(
  messages: OperationalChatMessageRecord[],
  memories: ChatEvidenceMemoryFact[] = [],
  options: { recentMessageCount?: number; recentCharLimit?: number } = {}
): CompiledChatContext {
  const recentMessageCount = Math.max(8, options.recentMessageCount ?? 18);
  const recentCharLimit = Math.max(4_000, options.recentCharLimit ?? 14_000);
  const ordered = messages
    .filter((message) => message.messageText.trim())
    .slice()
    .sort((a, b) => a.id - b.id);
  const workingMemory = compileWorkingMemory(ordered, memories);
  const recentMessages = takeRecentMessages(ordered, recentMessageCount, recentCharLimit);

  return {
    workingMemory,
    recentMessages,
    promptText: formatWorkingMemory(workingMemory, memories)
  };
}

/**
 * Resolve the user's referential task request against the whole conversation.
 * A long assistant synthesis is preferred because it has already organized
 * scattered requirements into an implementable brief. A short acknowledgement
 * or a meta instruction is never promoted to a task objective.
 */
export function resolveTaskContext(
  messages: ContextMessage[]
): ContextMessage | null {
  const candidates = messages
    .slice()
    .reverse()
    .filter((message) => isUsefulTaskContext(message.messageText));
  const synthesizedBrief = candidates.find((message) => (
    message.senderRole === "orchestrator"
    && message.messageText.trim().length >= 160
    && SYNTHESIS_MARKERS.test(message.messageText)
  ));
  if (synthesizedBrief) return synthesizedBrief;
  return candidates.find((message) => message.senderRole === "user") ?? candidates[0] ?? null;
}

export function isContextualTaskFollowUp(text: string): boolean {
  const asksForTask = /\b(?:crie|criar|cadastrar|cadastre|abra|abrir|faca|faça|prepare|preparar)\s+(?:(?:uma|um|a|o)\s+)?(?:task|tarefa)\b/i.test(text);
  const refersToContext = /\b(?:contexto|isso|acima|anterior|mensagem|mandei|enviado|descrito|descrevi|novamente|com\s+base|a\s+partir|conforme\s+(?:alinhamos|combinamos)|como\s+(?:alinhamos|combinamos)|conversa|chat|projeto)\b/i.test(text);
  return asksForTask && refersToContext;
}

/** True when the text is an instruction to reuse context, not a task objective. */
export function isTaskMetaRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  return isContextualTaskFollowUp(normalized)
    || /\b(?:conforme\s+(?:alinhamos|combinamos)|como\s+(?:alinhamos|combinamos)|a\s+partir\s+disso|com\s+base\s+(?:nessa|nesta|na)\s+(?:conversa|mensagem)|o\s+que\s+foi\s+descrito)\b/i.test(normalized)
    || /\b(?:crie|criar|abra|abrir|prepare|preparar)\s+(?:a|uma|um|o)\s+(?:task|tarefa)\b[^.!?]{0,120}\b(?:conforme|como|a\s+partir|com\s+base|alinhamos|combinamos|conversa|chat|descrito)\b/i.test(normalized);
}

/**
 * Operational failures are evidence for recovery, not implementation
 * objectives. Keeping this distinction deterministic prevents a message such
 * as "Task #6 waiting for provider" from becoming a new task when the user
 * asks the chat to reuse the conversation context.
 */
export function isOperationalIncidentMessage(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!INCIDENT_MARKERS.test(normalized)) return false;
  // Incident reports may quote a remediation suggestion later in the text.
  // The operational prefix still determines their role in task-context
  // selection; otherwise a support report can outrank the real product brief.
  if (/^(?:a\s+)?(?:task|tarefa|goal|objetivo|provider|provedor)\b[^.!?]{0,160}\b(?:waiting|aguardando|blocked|bloquead|permission|permiss[aã]o|falha|erro|failed|parou|interrompid)/i.test(normalized)) {
    return true;
  }
  if (IMPLEMENTATION_MARKERS.test(normalized)) return false;
  return /^(?:task|tarefa|goal|objetivo)\b/i.test(normalized)
    || /\b(?:provider|provedor|permission|permiss[aã]o|erro|falha|blocked|bloquead|waiting|aguardando|output|saida)\b/i.test(normalized);
}

function compileWorkingMemory(
  messages: OperationalChatMessageRecord[],
  memories: ChatEvidenceMemoryFact[]
): CompiledChatContext["workingMemory"] {
  const substantialUsers = messages.filter((message) => message.senderRole === "user" && isUsefulTaskContext(message.messageText));
  const syntheses = messages.filter((message) => (
    message.senderRole === "orchestrator"
    && message.messageText.trim().length >= 160
    && SYNTHESIS_MARKERS.test(message.messageText)
    && !HISTORY_MESSAGE.test(message.messageText)
  ));
  const objective = (syntheses.at(-1) ?? [...substantialUsers].sort((a, b) => b.messageText.length - a.messageText.length)[0])?.messageText.trim() ?? null;
  const digest = [...messages]
    .filter((message) => isUsefulTaskContext(message.messageText))
    .slice(-10)
    .map((message) => `${message.senderRole.toUpperCase()}: ${compact(message.messageText, message.senderRole === "orchestrator" ? 1_800 : 1_200)}`);
  const source = digest.join("\n");

  return {
    objective: objective ? compact(objective, 3_200) : null,
    requirements: extractListItems(source, 10),
    decisions: memories.filter((memory) => memory.kind === "decision").slice(0, 8).map((memory) => compact(memory.text, 300)),
    constraints: memories.filter((memory) => memory.kind === "constraint").slice(0, 8).map((memory) => compact(memory.text, 300)),
    openQuestions: extractQuestions(source, 6),
    digest
  };
}

function takeRecentMessages(
  messages: OperationalChatMessageRecord[],
  count: number,
  charLimit: number
): OperationalChatMessageRecord[] {
  const selected: OperationalChatMessageRecord[] = [];
  let chars = 0;
  for (const message of messages.slice(-count).reverse()) {
    const nextChars = chars + message.messageText.length;
    if (selected.length > 0 && nextChars > charLimit) break;
    selected.unshift(message);
    chars = nextChars;
  }
  return selected;
}

function formatWorkingMemory(
  memory: CompiledChatContext["workingMemory"],
  memories: ChatEvidenceMemoryFact[]
): string {
  return [
    "COMPILED WORKING MEMORY (derived from this conversation; use it to resolve references such as 'isso', 'a partir disso' and 'o que expliquei'):",
    `OBJECTIVE: ${memory.objective ?? "not established"}`,
    `REQUIREMENTS:\n${formatLines(memory.requirements)}`,
    `DECISIONS:\n${formatLines(memory.decisions)}`,
    `CONSTRAINTS:\n${formatLines(memory.constraints)}`,
    `OPEN QUESTIONS:\n${formatLines(memory.openQuestions)}`,
    `SOURCE DIGEST (recent substantive turns; meta requests and generic acknowledgements excluded):\n${formatLines(memory.digest)}`,
    memories.length === 0 ? "No persistent project memories." : "Persistent memories are listed separately in project evidence."
  ].join("\n");
}

function extractListItems(text: string, limit: number): string[] {
  const items = text
    .split(/\r?\n|(?=\b\d+[.)]\s)|(?=\*\s)/)
    .map((item) => item.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((item) => item.length >= 18 && !/^(?:olá|entendi|ficou perfeitamente claro|deseja que)/i.test(item));
  return [...new Set(items)].slice(0, limit).map((item) => compact(item, 420));
}

function extractQuestions(text: string, limit: number): string[] {
  return [...new Set((text.match(/[^.!?]{10,}\?/g) ?? []).map((value) => compact(value, 260)))].slice(0, limit);
}

function isUsefulTaskContext(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length < 40) return false;
  return !META_MESSAGE.test(normalized)
    && !HISTORY_MESSAGE.test(normalized)
    && !GENERIC_STATUS.test(normalized)
    && !GENERIC_FOLLOWUP.test(normalized)
    && !isOperationalIncidentMessage(normalized);
}

function formatLines(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trim()}…`;
}
