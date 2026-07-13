import { SECRET_PATTERNS } from "./secrets.js";

const SECRET_REDACTION_PATTERNS = SECRET_PATTERNS.map((pattern) => (
  new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)
));

const PRIVATE_KEY_NAMES = /(?:token|secret|password|credential|api[_-]?key|user[_-]?id|username|chat[_-]?id|worktree|path)/i;
const WINDOWS_PRIVATE_PATH = /[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s"']+/g;
const UNIX_PRIVATE_PATH = /\/(?:home|Users)\/[^\s"'/]+\/[^\s"']+/g;
const DISPLAY_TRUNCATION_SUFFIX = "... [truncado]";

export function redactSensitiveText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_REDACTION_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED_SECRET]");
  return redacted
    .replace(WINDOWS_PRIVATE_PATH, "[REDACTED_LOCAL_PATH]")
    .replace(UNIX_PRIVATE_PATH, "[REDACTED_LOCAL_PATH]");
}

export function containsSensitiveText(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => testPattern(pattern, value))
    || testPattern(WINDOWS_PRIVATE_PATH, value)
    || testPattern(UNIX_PRIVATE_PATH, value);
}

export function truncateForDisplay(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const cutoff = Math.max(0, maxLength - DISPLAY_TRUNCATION_SUFFIX.length);
  return `${value.slice(0, cutoff)}${DISPLAY_TRUNCATION_SUFFIX}`;
}

function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export function sanitizePublicMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePublicMetadata);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !PRIVATE_KEY_NAMES.test(key))
        .map(([key, item]) => [key, sanitizePublicMetadata(item)])
    );
  }
  return typeof value === "string" ? redactSensitiveText(value) : value;
}
