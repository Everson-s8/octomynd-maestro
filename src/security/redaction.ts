const SECRET_PATTERNS = [
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bgh[opsu]_[A-Za-z0-9]{20,}/g,
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
];

const PRIVATE_KEY_NAMES = /(?:token|secret|password|credential|api[_-]?key|user[_-]?id|username|chat[_-]?id|worktree|path)/i;
const WINDOWS_PRIVATE_PATH = /[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\r\n"']+/g;
const UNIX_PRIVATE_PATH = /\/(?:home|Users)\/[^\r\n"']+/g;

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
