import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runAgentProcess } from "../agents/process.js";
import { redactSensitiveText, truncateForDisplay } from "../security/redaction.js";
import {
  formatSecretScanFinding,
  scanWorktreePathsForSecrets
} from "../security/secrets.js";

export type ValidationCheckId =
  | "diff_check"
  | "secret_scan"
  | "typecheck_backend"
  | "typecheck_ui"
  | "tests_focused"
  | "tests_full"
  | "build_ui";

export type ValidationCheckResult = {
  id: ValidationCheckId;
  status: "passed" | "failed";
  durationMs: number;
  summary: string;
  artifactKey: string;
};

export type ValidationReport = {
  status: "passed" | "failed";
  summary: string;
  compactFailure: string | null;
  durationMs: number;
  checks: ValidationCheckResult[];
  reportArtifactKey: string;
};

export type ValidationRequest = {
  workspacePath: string;
  artifactsRoot: string;
  mode?: "focused" | "full";
  focusedTests?: string[];
  baseRef?: string;
  signal?: AbortSignal;
};

type CommandSpec = {
  id: Exclude<ValidationCheckId, "secret_scan">;
  command: string;
  args: string[];
  timeoutMs: number;
  skipReason?: string;
};

const RAW_OUTPUT_MAX_CHARS = 400_000;
const COMPACT_FAILURE_MAX_CHARS = 2_400;
const ALLOWED_FOCUSED_TEST = /^test\/[a-z0-9][a-z0-9._/-]*\.test\.ts$/i;
const ALLOWED_GIT_REF = /^[a-z0-9][a-z0-9._/-]*$/i;

export class DeterministicValidationRunner {
  constructor(private readonly executeProcess = runAgentProcess) {}

  async run(request: ValidationRequest): Promise<ValidationReport> {
    const startedAt = Date.now();
    const workspacePath = path.resolve(request.workspacePath);
    const invocationKey = path.posix.join("validation", crypto.randomUUID());
    const invocationRoot = path.join(request.artifactsRoot, ...invocationKey.split("/"));
    fs.mkdirSync(invocationRoot, { recursive: true });

    const checks: ValidationCheckResult[] = [];
    const specs = commandSpecs(workspacePath, request);
    checks.push(await runCommandCheck(
      this.executeProcess,
      specs[0],
      workspacePath,
      invocationRoot,
      invocationKey,
      request.signal
    ));
    checks.push(runSecretScan(workspacePath, invocationRoot, invocationKey, request.baseRef));
    if (checks.every((check) => check.status === "passed")) {
      for (const spec of specs.slice(1)) {
        checks.push(await runCommandCheck(
          this.executeProcess,
          spec,
          workspacePath,
          invocationRoot,
          invocationKey,
          request.signal
        ));
        if (request.signal?.aborted) break;
      }
    }

    const failed = checks.filter((check) => check.status === "failed");
    const status = failed.length === 0 ? "passed" : "failed";
    const compactFailure = status === "failed"
      ? truncateForDisplay(failed.map((check) => `${check.id}: ${check.summary}`).join("\n"), COMPACT_FAILURE_MAX_CHARS)
      : null;
    const reportArtifactKey = path.posix.join(invocationKey, "report.json");
    const report: ValidationReport = {
      status,
      summary: status === "passed"
        ? `${checks.length}/${checks.length} deterministic checks passed.`
        : `${failed.length}/${checks.length} deterministic checks failed: ${failed.map((check) => check.id).join(", ")}.`,
      compactFailure,
      durationMs: Date.now() - startedAt,
      checks,
      reportArtifactKey
    };
    fs.writeFileSync(path.join(invocationRoot, "report.json"), JSON.stringify(report, null, 2), "utf8");
    return report;
  }
}

function commandSpecs(workspacePath: string, request: ValidationRequest): CommandSpec[] {
  // Maestro validates arbitrary project worktrees, not only its own `ui/`
  // checkout. Generated applications commonly use `backend/` + `frontend/`,
  // so choose the project layout before constructing commands. Keep the old
  // root catalog as the fallback for Maestro itself and for minimal fixtures.
  const layout = detectProjectLayout(workspacePath);
  if (layout === "nested-app") {
    return nestedProjectCommandSpecs(workspacePath, request);
  }

  const typescriptBin = resolveRuntimeTool(workspacePath, "typescript", "bin/tsc");
  const vitestEntry = resolveRuntimeTool(workspacePath, "vitest", "vitest.mjs");
  const viteEntry = resolveRuntimeTool(workspacePath, "vite", "bin/vite.js");
  const tests = request.mode === "focused"
    ? validatedFocusedTests(request.focusedTests)
    : [];
  const testId: "tests_focused" | "tests_full" = tests.length > 0 ? "tests_focused" : "tests_full";
  const diffTarget = validatedBaseRef(request.baseRef);
  return [
    {
      id: "diff_check",
      command: "git",
      args: ["-C", workspacePath, "diff", "--check", ...(diffTarget ? [diffTarget] : [])],
      timeoutMs: 30_000
    },
    {
      id: "typecheck_backend",
      command: process.execPath,
      args: [typescriptBin, "--noEmit"],
      timeoutMs: 120_000
    },
    {
      id: "typecheck_ui",
      command: process.execPath,
      args: [typescriptBin, "--noEmit", "-p", "ui/tsconfig.json"],
      timeoutMs: 120_000
    },
    {
      id: testId,
      command: process.execPath,
      args: [vitestEntry, "run", ...tests],
      timeoutMs: tests.length > 0 ? 120_000 : 300_000
    },
    {
      id: "build_ui",
      command: process.execPath,
      args: [viteEntry, "build", "--config", "ui/vite.config.ts"],
      timeoutMs: 180_000
    }
  ];
}

type ProjectLayout = "root" | "nested-app";

function detectProjectLayout(workspacePath: string): ProjectLayout {
  const hasNestedBackend = hasAnyPath(workspacePath, ["backend/package.json", "backend/tsconfig.json"]);
  const hasNestedFrontend = hasAnyPath(workspacePath, [
    "frontend/package.json",
    "frontend/tsconfig.json",
    "frontend/vite.config.ts",
    "frontend/vite.config.js"
  ]);
  return hasNestedBackend || hasNestedFrontend ? "nested-app" : "root";
}

function nestedProjectCommandSpecs(workspacePath: string, request: ValidationRequest): CommandSpec[] {
  const typescriptBin = resolveRuntimeTool(workspacePath, "typescript", "bin/tsc");
  const vitestEntry = resolveRuntimeTool(workspacePath, "vitest", "vitest.mjs");
  const viteEntry = resolveRuntimeTool(workspacePath, "vite", "bin/vite.js");
  const backendTsconfig = firstExistingPath(workspacePath, ["backend/tsconfig.json", "tsconfig.json"]);
  const uiTsconfig = firstExistingPath(workspacePath, [
    "frontend/tsconfig.json",
    "ui/tsconfig.json",
    "tsconfig.ui.json"
  ]);
  const uiViteConfig = firstExistingPath(workspacePath, [
    "frontend/vite.config.ts",
    "frontend/vite.config.js",
    "ui/vite.config.ts",
    "ui/vite.config.js",
    "vite.config.ts",
    "vite.config.js"
  ]);
  const tests = request.mode === "focused"
    ? validatedFocusedTests(request.focusedTests)
    : [];
  const hasTests = tests.length > 0 || containsTestFile(workspacePath);
  const testId: "tests_focused" | "tests_full" = tests.length > 0 ? "tests_focused" : "tests_full";
  const diffTarget = validatedBaseRef(request.baseRef);

  return [
    {
      id: "diff_check",
      command: "git",
      args: ["-C", workspacePath, "diff", "--check", ...(diffTarget ? [diffTarget] : [])],
      timeoutMs: 30_000
    },
    {
      id: "typecheck_backend",
      command: process.execPath,
      args: backendTsconfig
        ? [typescriptBin, "--noEmit", "-p", backendTsconfig]
        : [],
      timeoutMs: 120_000,
      skipReason: backendTsconfig ? undefined : "nenhum tsconfig de backend encontrado"
    },
    {
      id: "typecheck_ui",
      command: process.execPath,
      args: uiTsconfig
        ? [typescriptBin, "--noEmit", "-p", uiTsconfig]
        : [],
      timeoutMs: 120_000,
      skipReason: uiTsconfig ? undefined : "nenhum tsconfig de frontend encontrado"
    },
    {
      id: testId,
      command: process.execPath,
      args: [vitestEntry, "run", ...tests],
      timeoutMs: tests.length > 0 ? 120_000 : 300_000,
      skipReason: hasTests ? undefined : "nenhum arquivo de teste encontrado"
    },
    {
      id: "build_ui",
      command: process.execPath,
      args: uiViteConfig
        ? [viteEntry, "build", "--config", uiViteConfig]
        : [],
      timeoutMs: 180_000,
      skipReason: uiViteConfig ? undefined : "No frontend Vite configuration was found"
    }
  ];
}

function hasAnyPath(workspacePath: string, relativePaths: string[]): boolean {
  return relativePaths.some((relativePath) => fs.existsSync(path.join(workspacePath, ...relativePath.split("/"))));
}

function firstExistingPath(workspacePath: string, relativePaths: string[]): string | null {
  return relativePaths.find((relativePath) => fs.existsSync(path.join(workspacePath, ...relativePath.split("/")))) ?? null;
}

function containsTestFile(rootPath: string): boolean {
  const ignored = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) stack.push(entryPath);
        continue;
      }
      if (/\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i.test(entry.name)) return true;
    }
  }
  return false;
}

function resolveRuntimeTool(workspacePath: string, packageName: string, relativePath: string): string {
  const roots = [
    workspacePath,
    process.env.MAESTRO_RUNTIME_ROOT?.trim()
  ].filter((root): root is string => Boolean(root));
  for (const root of roots) {
    const candidate = path.join(root, "node_modules", packageName, ...relativePath.split("/"));
    if (fs.existsSync(candidate)) return candidate;
  }
  // Keep the failure actionable for a non-packaged checkout: the validation
  // output points at the expected project-local dependency path.
  return path.join(workspacePath, "node_modules", packageName, ...relativePath.split("/"));
}

function validatedFocusedTests(values: string[] | undefined): string[] {
  const tests = [...new Set(values ?? [])].map((value) => value.replaceAll("\\", "/"));
  if (tests.some((value) => !ALLOWED_FOCUSED_TEST.test(value) || value.includes(".."))) {
    throw new Error("Focused tests must be repository-relative test/*.test.ts paths.");
  }
  return tests;
}

function validatedBaseRef(baseRef: string | undefined): string | null {
  if (!baseRef) return null;
  if (!ALLOWED_GIT_REF.test(baseRef) || baseRef.includes("..") || baseRef.endsWith("/")) {
    throw new Error("Validation baseRef must be a safe Git reference.");
  }
  return baseRef;
}

async function runCommandCheck(
  executeProcess: typeof runAgentProcess,
  spec: CommandSpec,
  workspacePath: string,
  invocationRoot: string,
  invocationKey: string,
  signal: AbortSignal | undefined
): Promise<ValidationCheckResult> {
  if (spec.skipReason) {
    const artifactKey = path.posix.join(invocationKey, `${spec.id}.raw.txt`);
    fs.writeFileSync(path.join(invocationRoot, `${spec.id}.raw.txt`), `SKIPPED: ${spec.skipReason}\n`, "utf8");
    return {
      id: spec.id,
      status: "passed",
      durationMs: 0,
      summary: `skipped: ${spec.skipReason}`,
      artifactKey
    };
  }
  const result = await executeProcess({
    command: spec.command,
    args: spec.args,
    cwd: workspacePath,
    timeoutMs: spec.timeoutMs,
    maxOutputChars: RAW_OUTPUT_MAX_CHARS,
    signal
  });
  const raw = redactSensitiveText([result.stdout, result.stderr].filter(Boolean).join("\n").trim());
  const artifactKey = path.posix.join(invocationKey, `${spec.id}.raw.txt`);
  fs.writeFileSync(path.join(invocationRoot, `${spec.id}.raw.txt`), raw, "utf8");
  const passed = result.exitCode === 0 && !result.timedOut && !result.aborted;
  return {
    id: spec.id,
    status: passed ? "passed" : "failed",
    durationMs: result.durationMs,
    summary: passed
      ? "passed"
      : compactCommandFailure(raw, result.timedOut ? "timed out" : result.aborted ? "cancelled" : `exit ${result.exitCode ?? "unknown"}`),
    artifactKey
  };
}

function runSecretScan(
  workspacePath: string,
  invocationRoot: string,
  invocationKey: string,
  baseRef: string | undefined
): ValidationCheckResult {
  const startedAt = Date.now();
  const changedFiles = listChangedFiles(workspacePath, validatedBaseRef(baseRef));
  const findings = scanWorktreePathsForSecrets(workspacePath, changedFiles);
  const output = findings.map(formatSecretScanFinding).join("\n");
  const artifactKey = path.posix.join(invocationKey, "secret_scan.raw.txt");
  fs.writeFileSync(path.join(invocationRoot, "secret_scan.raw.txt"), output, "utf8");
  return {
    id: "secret_scan",
    status: findings.length === 0 ? "passed" : "failed",
    durationMs: Date.now() - startedAt,
    summary: findings.length === 0
      ? `passed (${changedFiles.length} changed files)`
      : truncateForDisplay(output, COMPACT_FAILURE_MAX_CHARS),
    artifactKey
  };
}

function listChangedFiles(workspacePath: string, diffTarget: string | null): string[] {
  const tracked = runGitLines(workspacePath, [
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    diffTarget ?? "HEAD"
  ]);
  const untracked = runGitLines(workspacePath, ["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...tracked, ...untracked])];
}

function runGitLines(workspacePath: string, args: string[]): string[] {
  const result = spawnSync("git", ["-C", workspacePath, ...args], {
    cwd: workspacePath,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000
  });
  if (result.status !== 0) {
    throw new Error(`Git validation query failed: ${result.error?.message || result.stderr || result.stdout}`);
  }
  return (result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function compactCommandFailure(output: string, reason: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const evidence = lines.filter((line) => /error|failed|failure|expected|received|timeout|cannot|denied/i.test(line));
  const selected = (evidence.length > 0 ? evidence : lines.slice(-12)).slice(0, 20);
  return truncateForDisplay([reason, ...selected].join(" | "), COMPACT_FAILURE_MAX_CHARS);
}
