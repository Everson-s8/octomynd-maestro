export type FailureCategory =
  | "quota"
  | "auth_required"
  | "timeout"
  | "offline"
  | "capacity"
  | "output_limit"
  | "permission_denied"
  | "environment_error"
  | "invalid_output"
  | "user_cancelled"
  | "prompt_too_large"
  | "unknown";

export type FailureContext = {
  provider?: string;
  phase?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  aborted?: boolean;
  breakerReason?: string | null;
  spawnErrorCode?: string | null;
  stderrPrefix?: string;
  jsonError?: {
    code?: string | number;
    message?: string;
    type?: string;
    status?: number;
    error?: any;
  } | null;
};

const CATEGORY_LABELS: Record<FailureCategory, string> = {
  quota: "cota do provedor esgotada",
  auth_required: "autenticacao necessaria",
  timeout: "tempo limite excedido",
  offline: "provedor indisponivel",
  capacity: "nenhum provedor com capacidade disponivel",
  output_limit: "limite de saida excedido",
  permission_denied: "permissao negada",
  environment_error: "erro de ambiente",
  invalid_output: "saida invalida",
  user_cancelled: "cancelado pelo usuario",
  prompt_too_large: "tamanho do prompt excedido",
  unknown: "erro desconhecido"
};

const SUMMARY_MAX_LENGTH = 200;

// Layer 2 regex patterns for unstructured messages
const USER_CANCELLED_PATTERN = /cancelled by user|user cancelled|aborted by user|\bsigint\b|\bsigterm\b/i;
const OUTPUT_LIMIT_PATTERN = /output limit exceeded|max chars exceeded|output length exceeded|response too large/i;
const INVALID_OUTPUT_PATTERN = /saida invalida|invalid json|unexpected token|invalid output|failed to parse output|result schema/i;
const QUOTA_PATTERN = /usage limit|session limit|rate limit|quota|credits exhausted|no credits|\b429\b|too many requests|resets?\s+\d/i;
const AUTH_PATTERN = /\b401\b|unauthorized|authentication|not logged in|please run \/login|sign in|invalid credentials|login required/i;
const PERMISSION_PATTERN = /\b403\b|permission denied|access denied|permission check failed|user denied permission|auto[- ]denied|cannot prompt for|required the ["']command["'] permission|headless mode cannot prompt|soft[- ]denied|permiss[aã]o negada|verifica[cç][aã]o de permiss[aã]o|\beacces\b|\beperm\b/i;
const ENVIRONMENT_PATTERN = /cannot find module|command not found|\benoent\b|module_not_found|node_module/i;
const OFFLINE_PATTERN = /connection refused|network is unreachable|\boffline\b|dns lookup failed|getaddrinfo\b|econnrefused|etimedout|socket hang up/i;
const CAPACITY_PATTERN = /resource_exhausted|no provider available|all providers busy|overloaded|capacity|high demand|server is busy/i;
const PROMPT_TOO_LARGE_PATTERN = /enametoolong|e2big|argument list too long|prompt too (large|long)|command line too long|request entity too large|context length exceeded|maximum context length/i;

export function classifyFailure(text: string, contextOrTimedOut?: boolean | FailureContext): FailureCategory {
  const context: FailureContext = typeof contextOrTimedOut === "boolean"
    ? { timedOut: contextOrTimedOut }
    : contextOrTimedOut ?? {};

  // --- Layer 1: Structural signals ---
  if (context.aborted) {
    return "user_cancelled";
  }

  if (
    context.timedOut ||
    context.breakerReason === "inactivity" ||
    context.breakerReason === "phase_timeout" ||
    context.breakerReason === "deadline"
  ) {
    return "timeout";
  }

  if (
    context.breakerReason === "output_limit" ||
    context.breakerReason === "duplicate_output"
  ) {
    return "output_limit";
  }

  if (context.spawnErrorCode) {
    const code = context.spawnErrorCode.toUpperCase();
    if (code === "ENAMETOOLONG" || code === "E2BIG") {
      return "prompt_too_large";
    }
    if (code === "ENOENT" || code === "MODULE_NOT_FOUND" || code === "COMMAND_NOT_FOUND") {
      return "environment_error";
    }
    if (code === "EACCES" || code === "EPERM") {
      return "permission_denied";
    }
  }

  if (context.exitCode === 127) {
    return "environment_error";
  }
  if (context.exitCode === 126) {
    return "permission_denied";
  }

  if (context.jsonError) {
    const errCode = String(context.jsonError.code ?? context.jsonError.type ?? "").toLowerCase();
    const errStatus = context.jsonError.status;
    if (errCode === "prompt_too_large" || errCode === "context_length_exceeded" || errCode === "enametoolong" || errCode === "e2big") {
      return "prompt_too_large";
    }
    if (errCode === "quota_exceeded" || errCode === "rate_limit_exceeded" || errStatus === 429) {
      return "quota";
    }
    if (errCode === "unauthorized" || errStatus === 401) {
      return "auth_required";
    }
    if (errCode === "permission_denied" || errStatus === 403) {
      return "permission_denied";
    }
    if (errCode === "invalid_output" || errCode === "parse_error") {
      return "invalid_output";
    }
    if (errCode === "environment_error") {
      return "environment_error";
    }
    if (errCode === "user_cancelled") {
      return "user_cancelled";
    }
  }

  if (context.stderrPrefix) {
    const prefix = context.stderrPrefix.toUpperCase();
    if (prefix.includes("ENAMETOOLONG") || prefix.includes("E2BIG") || prefix.includes("ERR_PROMPT_TOO_LARGE")) {
      return "prompt_too_large";
    }
    if (prefix.includes("ERR_ENVIRONMENT") || prefix.includes("ENOENT") || prefix.includes("MODULE_NOT_FOUND")) {
      return "environment_error";
    }
    if (prefix.includes("ERR_PERMISSION") || prefix.includes("EACCES")) {
      return "permission_denied";
    }
    if (prefix.includes("ERR_QUOTA")) {
      return "quota";
    }
    if (prefix.includes("ERR_AUTH")) {
      return "auth_required";
    }
    if (prefix.includes("ERR_INVALID_OUTPUT")) {
      return "invalid_output";
    }
    if (prefix.includes("ERR_USER_CANCELLED")) {
      return "user_cancelled";
    }
  }

  // Check structured stderr line prefix signatures in text if any
  if (text.startsWith("ERR_PROMPT_TOO_LARGE:") || text.startsWith("ENAMETOOLONG:") || text.startsWith("E2BIG:")) {
    return "prompt_too_large";
  }
  if (text.startsWith("ERR_ENVIRONMENT:") || text.startsWith("ENOENT:") || text.startsWith("MODULE_NOT_FOUND:")) {
    return "environment_error";
  }
  if (text.startsWith("ERR_PERMISSION:") || text.startsWith("EACCES:")) {
    return "permission_denied";
  }
  if (text.startsWith("ERR_QUOTA:")) {
    return "quota";
  }
  if (text.startsWith("ERR_AUTH:")) {
    return "auth_required";
  }
  if (text.startsWith("ERR_INVALID_OUTPUT:")) {
    return "invalid_output";
  }
  if (text.startsWith("ERR_USER_CANCELLED:")) {
    return "user_cancelled";
  }

  // --- Layer 2: Regex for unstructured text ---
  if (PROMPT_TOO_LARGE_PATTERN.test(text)) return "prompt_too_large";
  if (USER_CANCELLED_PATTERN.test(text)) return "user_cancelled";
  if (OUTPUT_LIMIT_PATTERN.test(text)) return "output_limit";
  if (INVALID_OUTPUT_PATTERN.test(text)) return "invalid_output";
  if (QUOTA_PATTERN.test(text)) return "quota";
  if (AUTH_PATTERN.test(text)) return "auth_required";
  if (PERMISSION_PATTERN.test(text)) return "permission_denied";
  if (ENVIRONMENT_PATTERN.test(text)) return "environment_error";
  if (OFFLINE_PATTERN.test(text)) return "offline";
  if (CAPACITY_PATTERN.test(text)) return "capacity";

  return "unknown";
}

export function failureCategoryLabel(category: FailureCategory): string {
  return CATEGORY_LABELS[category] ?? "erro desconhecido";
}

const RETRYABLE_CATEGORIES = new Set<FailureCategory>([
  "quota",
  "auth_required",
  "timeout",
  "offline",
  "capacity"
]);

export function isRetryableFailureCategory(category: FailureCategory): boolean {
  return RETRYABLE_CATEGORIES.has(category);
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
