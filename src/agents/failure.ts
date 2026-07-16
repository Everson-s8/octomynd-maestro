export type FailureCategory = "quota" | "auth_required" | "timeout" | "offline" | "capacity" | "unknown";

const QUOTA_PATTERN = /usage limit|session limit|rate limit|quota|credits exhausted|no credits|429\b|too many requests|resets?\s+\d/i;
const AUTH_PATTERN = /\b401\b|unauthorized|authentication|not logged in|please run \/login|sign in|invalid credentials|login required/i;
const OFFLINE_PATTERN = /not found|cannot find module|connection refused|network is unreachable|offline|enoent/i;

const CATEGORY_LABELS: Record<FailureCategory, string> = {
  quota: "cota do provedor esgotada",
  auth_required: "autenticacao necessaria",
  timeout: "tempo limite excedido",
  offline: "provedor indisponivel",
  capacity: "nenhum provedor com capacidade disponivel",
  unknown: "erro desconhecido"
};

const SUMMARY_MAX_LENGTH = 200;

export function classifyFailure(text: string, timedOut = false): FailureCategory {
  if (timedOut) return "timeout";
  if (QUOTA_PATTERN.test(text)) return "quota";
  if (AUTH_PATTERN.test(text)) return "auth_required";
  if (OFFLINE_PATTERN.test(text)) return "offline";
  return "unknown";
}

export function failureCategoryLabel(category: FailureCategory): string {
  return CATEGORY_LABELS[category];
}

export function isRetryableFailureCategory(category: FailureCategory): boolean {
  return category !== "unknown";
}

export function retryAfterMsForFailure(category: FailureCategory): number | undefined {
  if (category === "timeout") return 15_000;
  if (category === "quota" || category === "auth_required") return 10 * 60_000;
  if (category === "offline") return 60_000;
  if (category === "capacity") return 30_000;
  return undefined;
}

export function buildFailureSummary(providerLabel: string, phase: string, category: FailureCategory): string {
  const summary = `${providerLabel} (${phase}): ${failureCategoryLabel(category)}.`;
  return summary.length <= SUMMARY_MAX_LENGTH ? summary : `${summary.slice(0, SUMMARY_MAX_LENGTH - 1)}.`;
}
