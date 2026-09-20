import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { runGit } from "../git.js";
import { redactSensitiveText } from "../security/redaction.js";

const MAX_TREE_ENTRIES = 240;
const MAX_READ_FILES = 10;
const MAX_FILE_BYTES = 24_000;
const MAX_TOTAL_BYTES = 120_000;
const MAX_GIT_OUTPUT = 8_000;

const DEFAULT_CONTEXT_FILES = [
  "README.md",
  "AGENTS.md",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "src/index.ts",
  "src/main.ts",
  "src/App.tsx",
  "ui/src/App.tsx",
  "docs/README.md"
];
const BROAD_CONTEXT_REQUEST = /\b(?:project|projeto|context|contexto|architecture|arquitetura|structure|estrutura|study|estud|analys|analis|review|revis|implement|implemen|refactor|refator|task|tarefa|downloaded|baixad|code|codigo|app|application|aplicacao)\b/i;

const IGNORED_DIRECTORIES = new Set([
  ".git", ".maestro", "node_modules", "dist", "build", "coverage", "release",
  ".next", ".vite", "out", "tmp", "temp"
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs", ".css", ".html", ".ini", ".js", ".json", ".md", ".mjs", ".ps1",
  ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml"
]);

export type ChatProjectFileFact = {
  path: string;
  size: number;
  content: string | null;
  truncated: boolean;
};

export type ChatProjectGitContext = {
  available: boolean;
  branch: string | null;
  headSha: string | null;
  status: string;
  commits: string;
  diffStat: string;
  remoteUrl: string | null;
  pullRequests: string;
  ci: string;
  detail: string | null;
};

export type ChatProjectContext = {
  files: ChatProjectFileFact[];
  git: ChatProjectGitContext;
  warnings: string[];
  summaryText: string;
};

export function inspectProjectContext(projectRoot: string, userMessage = ""): ChatProjectContext {
  const root = path.resolve(projectRoot);
  const warnings: string[] = [];
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return {
      files: [],
      git: unavailableGitContext("The registered project directory is unavailable."),
      warnings: ["The registered project directory is unavailable."],
      summaryText: "Project files: unavailable."
    };
  }

  const tree: string[] = [];
  walkTree(root, root, tree, warnings);
  const requestedPaths = extractRequestedPaths(userMessage);
  const readCandidates = requestedPaths.length > 0
    ? requestedPaths
    : BROAD_CONTEXT_REQUEST.test(userMessage)
      ? DEFAULT_CONTEXT_FILES
      : DEFAULT_CONTEXT_FILES.slice(0, 4);
  const files: ChatProjectFileFact[] = [];
  let totalBytes = 0;
  for (const relativePath of readCandidates) {
    if (files.length >= MAX_READ_FILES || totalBytes >= MAX_TOTAL_BYTES) break;
    const absolutePath = resolveProjectPath(root, relativePath);
    if (!absolutePath) {
      warnings.push(`Rejected out-of-project or unsafe file reference: ${relativePath}`);
      continue;
    }
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile() || isSecretPath(relativePath)) continue;
    const extension = path.extname(relativePath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension) && path.basename(relativePath) !== "Dockerfile") continue;
    try {
      const stat = fs.statSync(absolutePath);
      const remaining = Math.max(0, MAX_TOTAL_BYTES - totalBytes);
      const readBytes = Math.min(stat.size, MAX_FILE_BYTES, remaining);
      const buffer = fs.readFileSync(absolutePath).subarray(0, readBytes);
      const raw = buffer.toString("utf8").replace(/\u0000/g, "�");
      const content = redactSensitiveText(raw);
      files.push({
        path: normalizeRelativePath(relativePath),
        size: stat.size,
        content,
        truncated: stat.size > readBytes
      });
      totalBytes += readBytes;
    } catch {
      warnings.push(`Could not read ${normalizeRelativePath(relativePath)}.`);
    }
  }

  const git = inspectProjectGit(root, /\b(?:pr|pull\s*request|github|ci|workflow|remote|actions?)\b/i.test(userMessage));
  const summaryParts = [
    "The registered project tree and selected text files below are the source of truth for this answer; do not claim project knowledge that is not present in this evidence.",
    `Files visible in project scope (${tree.length} entries${tree.length >= MAX_TREE_ENTRIES ? ", truncated" : ""}): ${tree.join(", ") || "none"}`,
    `Files read for this question: ${files.map((file) => `${file.path}${file.truncated ? " (truncated)" : ""}`).join(", ") || "none"}`,
    `Git: ${git.available ? `${git.branch ?? "detached HEAD"}, ${git.headSha ?? "no commit"}` : git.detail ?? "unavailable"}`
  ];
  if (warnings.length > 0) summaryParts.push(`Context warnings: ${warnings.join(" ")}`);
  return { files, git, warnings, summaryText: summaryParts.join("\n") };
}

function walkTree(root: string, current: string, tree: string[], warnings: string[]): void {
  if (tree.length >= MAX_TREE_ENTRIES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    warnings.push(`Could not inspect ${relativeDisplayPath(root, current)}.`);
    return;
  }
  for (const entry of entries) {
    if (tree.length >= MAX_TREE_ENTRIES) return;
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    const relative = relativeDisplayPath(root, absolute);
    if (entry.isDirectory()) {
      tree.push(`${relative}/`);
      walkTree(root, absolute, tree, warnings);
    } else if (entry.isFile() && !isSecretPath(relative)) {
      tree.push(relative);
    }
  }
}

function inspectProjectGit(root: string, includeRemote: boolean): ChatProjectGitContext {
  if (!fs.existsSync(path.join(root, ".git"))) return unavailableGitContext("Not a Git repository.");
  const branch = runGit(["symbolic-ref", "--short", "HEAD"], root);
  const head = runGit(["rev-parse", "--verify", "HEAD"], root);
  const status = runGit(["status", "--short", "--branch"], root);
  const commits = runGit(["log", "-8", "--oneline", "--decorate"], root);
  const diffStat = runGit(["diff", "--stat"], root);
  const remote = runGit(["remote", "get-url", "origin"], root);
  const remoteContext = includeRemote ? inspectGitHubRemote(root) : { pullRequests: "", ci: "" };
  return {
    available: true,
    branch: branch.ok ? branch.stdout.trim() || null : null,
    headSha: head.ok ? head.stdout.trim() || null : null,
    status: redactSensitiveText(limitOutput(status.ok ? status.stdout : status.stderr)),
    commits: redactSensitiveText(limitOutput(commits.ok ? commits.stdout : commits.stderr)),
    diffStat: redactSensitiveText(limitOutput(diffStat.ok ? diffStat.stdout : diffStat.stderr)),
    remoteUrl: remote.ok ? redactSensitiveText(remote.stdout.trim()) || null : null,
    ...remoteContext,
    detail: status.ok ? null : redactSensitiveText(status.stderr || status.stdout || "Git status failed.")
  };
}

function unavailableGitContext(detail: string): ChatProjectGitContext {
  return { available: false, branch: null, headSha: null, status: "", commits: "", diffStat: "", remoteUrl: null, pullRequests: "", ci: "", detail };
}

function inspectGitHubRemote(root: string): Pick<ChatProjectGitContext, "pullRequests" | "ci"> {
  const pullRequests = runReadOnlyGh(["pr", "list", "--limit", "10", "--json", "number,title,state,isDraft,headRefName,baseRefName,updatedAt"], root);
  const ci = runReadOnlyGh(["run", "list", "--limit", "10", "--json", "name,status,conclusion,headBranch,createdAt"], root);
  return { pullRequests, ci };
}

function runReadOnlyGh(args: string[], cwd: string): string {
  try {
    const result = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 5_000, windowsHide: true });
    if (result.error || result.status !== 0) return redactSensitiveText(result.stderr?.trim() || "GitHub CLI unavailable or request failed.");
    return redactSensitiveText(limitOutput(result.stdout ?? ""));
  } catch (error) {
    return error instanceof Error ? redactSensitiveText(error.message) : "GitHub CLI unavailable or request failed.";
  }
}

function extractRequestedPaths(message: string): string[] {
  const candidates = message.match(/[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+|(?:README|Dockerfile|Makefile|package|tsconfig)[A-Za-z0-9_.-]*/g) ?? [];
  return [...new Set(candidates.map((candidate) => normalizeRelativePath(candidate)).filter(Boolean))];
}

function resolveProjectPath(root: string, relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) return null;
  const resolved = path.resolve(root, normalized);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function isSecretPath(relativePath: string): boolean {
  const basename = path.basename(relativePath).toLowerCase();
  return basename === ".env"
    || basename.startsWith(".env.")
    || /(?:secret|credential|password|token|private|\.pem$|\.key$)/i.test(basename);
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function relativeDisplayPath(root: string, absolute: string): string {
  return normalizeRelativePath(path.relative(root, absolute));
}

function limitOutput(value: string): string {
  const output = value.trim();
  return output.length > MAX_GIT_OUTPUT ? `${output.slice(0, MAX_GIT_OUTPUT)}… [truncated]` : output;
}
