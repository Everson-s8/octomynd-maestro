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
  };
  recentMessages: OperationalChatMessageRecord[];
  promptText: string;
};

type ContextMessage = Pick<OperationalChatMessageRecord, "senderRole" | "messageText"> & Partial<Pick<OperationalChatMessageRecord, "id">>;

const META_MESSAGE = /^(?:eu\s+)?(?:quero|preciso|pode|por favor)?\s*(?:crie|criar|abra|abrir)\s+(?:uma\s+)?task\b/i;
const HISTORY_MESSAGE = /^(?:sim,?\s+)?(?:consigo|posso)\s+(?:recuperar|conversar)\s+(?:o\s+)?hist[oó]rico/i;
const GENERIC_STATUS = /^nenhuma\s+task\s+parada/i;
const GENERIC_FOLLOWUP = /^mensagem\s+de\s+(?:acompanhamento|follow[- ]?up)\b/i;
const SYNTHESIS_MARKERS = /\b(?:objetivo|escopo|problema|sistema|implementar|funcionalidade|requisito|gest[aã]o|d[ií]vida|plano|vers[aã]o)\b/i;

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
  const asksForTask = /\b(?:crie|criar|cadastrar|cadastre|abra|abrir|faca|faça)\s+(?:uma\s+)?task\b/i.test(text);
  const refersToContext = /\b(?:contexto|isso|acima|anterior|mensagem|mandei|enviado|descrito|descrevi|novamente|com\s+base|a\s+partir)\b/i.test(text);
  return asksForTask && refersToContext;
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
  const source = [substantialUsers.at(-1)?.messageText, syntheses.at(-1)?.messageText].filter(Boolean).join("\n");

  return {
    objective: objective ? compact(objective, 3_200) : null,
    requirements: extractListItems(source, 10),
    decisions: memories.filter((memory) => memory.kind === "decision").slice(0, 8).map((memory) => compact(memory.text, 300)),
    constraints: memories.filter((memory) => memory.kind === "constraint").slice(0, 8).map((memory) => compact(memory.text, 300)),
    openQuestions: extractQuestions(source, 6)
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
    && !GENERIC_FOLLOWUP.test(normalized);
}

function formatLines(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trim()}…`;
}
