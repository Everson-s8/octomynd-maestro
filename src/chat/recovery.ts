import type { GovernedChatActionType } from "./types.js";

export type RecoveryTarget = {
  type: "goal" | "task" | "provider";
  id: number | string;
  status: string;
};

export type RecoveryDecision = {
  type: Extract<GovernedChatActionType, "resume_goal" | "retry_task" | "unblock_provider">;
  targetId: number | string;
};

/**
 * The chat's recovery seam. It deliberately accepts only state facts and a
 * message, so callers do not need to know how users phrase "try again" or
 * which lifecycle action is appropriate for the current state.
 */
export function resolveRecoveryDecision(message: string, targets: RecoveryTarget[], recentUserMessages: readonly string[] = []): RecoveryDecision | null {
  if (!isRecoveryRequest(message, recentUserMessages)) return null;

  const resumableGoals = targets.filter((target) => target.type === "goal" && ["blocked", "failed", "waiting_provider"].includes(target.status));
  if (resumableGoals.length === 1) {
    return { type: "resume_goal", targetId: resumableGoals[0].id };
  }
  if (resumableGoals.length > 1) return null;

  const retryableTasks = targets.filter((target) => target.type === "task" && ["blocked", "failed", "waiting_quota", "waiting_provider", "waiting_dependency"].includes(target.status));
  if (retryableTasks.length === 1) {
    return { type: "retry_task", targetId: retryableTasks[0].id };
  }
  if (retryableTasks.length > 1) return null;

  const disabledProviders = targets.filter((target) => target.type === "provider" && ["paused", "disabled"].includes(target.status));
  if (disabledProviders.length === 1) {
    return { type: "unblock_provider", targetId: disabledProviders[0].id };
  }

  return null;
}

export function isRecoveryRequest(input: string, recentUserMessages: readonly string[] = []): boolean {
  const normalized = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
  if (!normalized || /\?\s*$/.test(normalized)) return false;
  if (/^(?:como|por que|porque|o que|what|why|how)\b/.test(normalized)) return false;

  if (/\b(?:desbloque\w*|retom\w*|reinici\w*|reabr\w*|retry|resume|unblock|reopen|continue|prossegu\w*|tente\s+novamente|tentar\s+novamente|try\s+again|run\s+again|de\s+novo)\b/.test(normalized)) {
    return true;
  }

  // A short acknowledgement often follows the actual recovery request:
  // "tente novamente" -> "acho que agora você consegue". In that case the
  // conversation, not the last sentence alone, is the user's command.
  const acknowledgement = /^(?:acho|creio|acredito|agora|talvez|pode|consegue|sim|isso|certo|ok|vamos)\b[\s\S]{0,180}\b(?:consegue|conseguir|pode|podemos|agora|tenta|tente|funciona|funcionar)\b/.test(normalized)
    || /\b(?:agora|dessa\s+vez)\b[\s\S]{0,120}\b(?:consegue|pode|tenta|funciona)\b/.test(normalized);
  if (!acknowledgement) return false;

  return recentUserMessages.some((message) => {
    const prior = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return /\b(?:desbloque\w*|retom\w*|reinici\w*|reabr\w*|retry|resume|unblock|reopen|tente\s+novamente|tentar\s+novamente|try\s+again|run\s+again|de\s+novo)\b/.test(prior);
  });
}
