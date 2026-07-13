// Lookbehinds require the match to start at a real token boundary (not preceded by an
// alnum/underscore), so an incidental "sk-" inside a longer identifier like a branch name
// (e.g. "task-10-...") is not mistaken for an API key prefix.
const SECRET_PATTERNS = [
  /(?<![A-Za-z0-9_])sk-ant-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9_])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[opsu]_[A-Za-z0-9]{20,}/g,
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
];

const PRIVATE_KEY_NAMES = /(?:token|secret|password|credential|api[_-]?key|user[_-]?id|username|chat[_-]?id|worktree|path)/i;
// Bounded to a single whitespace-free run so an incidental path-like substring inside a longer
// sentence (a task description or branch name) does not redact the rest of the text. Unix paths
// additionally require a second segment (e.g. `/home/<user>/<file>`) so short route-like mentions
// such as "/home/dashboard" or "/Users/:id" are not mistaken for a real filesystem path.
const WINDOWS_PRIVATE_PATH = /[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s"']+/g;
const UNIX_PRIVATE_PATH = /\/(?:home|Users)\/[^\s"'/]+\/[^\s"']+/g;
const DISPLAY_TRUNCATION_SUFFIX = "... [truncado]";

export function redactSensitiveText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED_SECRET]");
  return redacted
    .replace(WINDOWS_PRIVATE_PATH, "[REDACTED_LOCAL_PATH]")
    .replace(UNIX_PRIVATE_PATH, "[REDACTED_LOCAL_PATH]");
}

export function containsSensitiveText(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => testPattern(pattern, value))
    || testPattern(WINDOWS_PRIVATE_PATH, value)
    || testPattern(UNIX_PRIVATE_PATH, value);
}

function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export function truncateForDisplay(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const cutoff = Math.max(0, maxLength - DISPLAY_TRUNCATION_SUFFIX.length);
  return `${value.slice(0, cutoff)}${DISPLAY_TRUNCATION_SUFFIX}`;
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
