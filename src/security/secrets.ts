import fs from "node:fs";
import path from "node:path";

export type SecretScanFindingReason =
  | "sensitive filename"
  | "outside worktree"
  | "secret-shaped content";

export type SecretScanFinding = {
  relativePath: string;
  reason: SecretScanFindingReason;
};

export const SECRET_PATTERNS = [
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /\bgh[opsu]_[A-Za-z0-9]{20,}/,
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];

const SENSITIVE_FILE_NAMES = new Set([
  ".credentials.json",
  ".env",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "secrets.json"
]);

export function scanWorktreePathsForSecrets(
  worktreePath: string,
  relativePaths: string[]
): SecretScanFinding[] {
  const findings: SecretScanFinding[] = [];
  const worktreeRoot = path.resolve(worktreePath);

  for (const relativePath of relativePaths) {
    const normalized = normalizeRelativePath(relativePath);
    const fileName = path.posix.basename(normalized).toLowerCase();
    if (isSensitiveFileName(fileName)) {
      findings.push({ relativePath: normalized, reason: "sensitive filename" });
      continue;
    }

    const absolutePath = path.resolve(worktreePath, relativePath);
    const relativeToRoot = path.relative(worktreeRoot, absolutePath);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      findings.push({ relativePath: redactUnsafePath(normalized), reason: "outside worktree" });
      continue;
    }

    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
    const buffer = fs.readFileSync(absolutePath);
    if (buffer.length > 2_000_000 || buffer.includes(0)) continue;
    const content = buffer.toString("utf8");
    if (SECRET_PATTERNS.some((pattern) => testPattern(pattern, content))) {
      findings.push({ relativePath: normalized, reason: "secret-shaped content" });
    }
  }

  return findings;
}

export function formatSecretScanFinding(finding: SecretScanFinding): string {
  return `${finding.relativePath}: ${finding.reason}`;
}

export function isSensitiveFileName(fileName: string): boolean {
  if (SENSITIVE_FILE_NAMES.has(fileName)) return true;
  return fileName.startsWith(".env.") && fileName !== ".env.example";
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function redactUnsafePath(value: string): string {
  return value.startsWith("../") || path.isAbsolute(value) || /^[A-Za-z]:\//.test(value)
    ? "[REDACTED_PATH]"
    : value;
}

function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}
