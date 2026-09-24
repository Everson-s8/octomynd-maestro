import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildRestrictedAgentEnvironment, runAgentProcess } from "../agents/process.js";
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
  | "prepare_environment"
  | "python_compile"
  | "tests_focused"
  | "tests_full"
  | "tests_python"
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
  /**
   * Provision the worktree before the checks: create `.venv` and install the
   * Python manifest, and install Node dependencies where `node_modules` is
   * missing. Missing dependencies used to fail every check and leave the Goal
   * depending on the provider deciding to repair the environment.
   */
  prepareEnvironment?: boolean;
};

type CommandSpec = {
  id: Exclude<ValidationCheckId, "secret_scan" | "prepare_environment">;
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
    checks.push(await runCommandCheck(
      this.executeProcess,
      commandSpecs(workspacePath, request)[0],
      workspacePath,
      invocationRoot,
      invocationKey,
      request.signal
    ));
    checks.push(runSecretScan(workspacePath, invocationRoot, invocationKey, request.baseRef));
    if (checks.every((check) => check.status === "passed")) {
      if (request.prepareEnvironment) {
        checks.push(await prepareEnvironment(
          this.executeProcess,
          workspacePath,
          invocationRoot,
          invocationKey,
          request.signal
        ));
      }
      // Built after provisioning: a `.venv` created above must be the
      // interpreter used by the Python checks.
      for (const spec of commandSpecs(workspacePath, request).slice(1)) {
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
  if (layout === "python") {
    return pythonProjectCommandSpecs(workspacePath, request);
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

type ProjectLayout = "root" | "nested-app" | "python";

// Generated apps do not always use `frontend/` and `backend/`: `frontend-ts/`,
// `web/`, `client/`, `server/` or `api/` were validated as a bare Python or
// root project, so the frontend was never type-checked or built.
const FRONTEND_DIR = /^(?:frontend|client|web)(?:[-_.][a-z0-9._-]+)?$/i;
const BACKEND_DIR = /^(?:backend|server|api)(?:[-_.][a-z0-9._-]+)?$/i;
const APP_MANIFESTS = ["package.json", "tsconfig.json", "vite.config.ts", "vite.config.js"];

function findAppDir(workspacePath: string, pattern: RegExp, preferred: string): string | null {
  const isApp = (dir: string) => hasAnyPath(workspacePath, APP_MANIFESTS.map((file) => `${dir}/${file}`));
  if (isApp(preferred)) return preferred;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspacePath, { withFileTypes: true });
  } catch {
    return null;
  }
  return entries
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name) && isApp(entry.name))
    .map((entry) => entry.name)
    .sort()[0] ?? null;
}

function hasPythonProject(workspacePath: string): boolean {
  return hasAnyPath(workspacePath, PYTHON_MANIFESTS) || containsPythonSourceFile(workspacePath);
}

const PYTHON_MANIFESTS = [
  "pyproject.toml",
  "requirements.txt",
  "requirements-dev.txt",
  "requirements-test.txt",
  "Pipfile",
  "setup.py",
  "setup.cfg",
  "pytest.ini",
  "tox.ini",
  "environment.yml"
];

function detectProjectLayout(workspacePath: string): ProjectLayout {
  const hasNestedBackend = findAppDir(workspacePath, BACKEND_DIR, "backend") !== null;
  const hasNestedFrontend = findAppDir(workspacePath, FRONTEND_DIR, "frontend") !== null;
  if (hasNestedBackend || hasNestedFrontend) return "nested-app";

  const hasTypeScriptManifest = hasAnyPath(workspacePath, [
    "package.json",
    "tsconfig.json",
    "ui/tsconfig.json",
    "vite.config.ts",
    "vite.config.js"
  ]);
  return hasPythonProject(workspacePath) && !hasTypeScriptManifest ? "python" : "root";
}

function pythonProjectCommandSpecs(workspacePath: string, request: ValidationRequest): CommandSpec[] {
  const python = resolvePythonInvocation(workspacePath);
  const focusedTests = request.mode === "focused"
    ? validatedFocusedTests(request.focusedTests, "python")
    : [];
  const tests = focusedTests.length > 0 ? focusedTests : [];
  const hasTests = tests.length > 0 || containsPythonTestFile(workspacePath);
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
      id: "python_compile",
      command: python.command,
      args: [
        ...python.prefixArgs,
        "-m", "compileall", "-q", "-x",
        "(^|[\\\\/])(?:\\.git|\\.venv|venv|node_modules|dist|build)([\\\\/]|$)",
        "."
      ],
      timeoutMs: 120_000
    },
    {
      id: testId,
      command: python.command,
      args: [...python.prefixArgs, "-m", "pytest", "-q", ...tests],
      timeoutMs: tests.length > 0 ? 120_000 : 300_000,
      skipReason: hasTests ? undefined : "no Python test files found"
    }
  ];
}

function resolvePythonInvocation(workspacePath: string): { command: string; prefixArgs: string[] } {
  const virtualEnvironmentPython = process.platform === "win32"
    ? path.join(workspacePath, ".venv", "Scripts", "python.exe")
    : path.join(workspacePath, ".venv", "bin", "python");
  if (fs.existsSync(virtualEnvironmentPython)) {
    return { command: virtualEnvironmentPython, prefixArgs: [] };
  }
  return resolveBasePython();
}

type PythonInvocation = { command: string; prefixArgs: string[] };
let cachedBasePython: PythonInvocation | undefined;

/**
 * The first Python 3 interpreter that actually runs.
 *
 * `py -3` resolves to the launcher's default, which can be a broken install
 * (seen on a user machine: Python 3.13 answered "%1 is not a valid Win32
 * application" while 3.12 and 3.9 worked), and `python` on PATH can be the
 * Microsoft Store stub. Probe the candidates instead of trusting the first
 * name, and fall back to the old default so a failure stays actionable.
 */
function resolveBasePython(): PythonInvocation {
  if (cachedBasePython) return cachedBasePython;
  const fallback: PythonInvocation = process.platform === "win32"
    ? { command: "py", prefixArgs: ["-3"] }
    : { command: "python3", prefixArgs: [] };
  const candidates: PythonInvocation[] = [fallback];
  const lines = (command: string, args: string[]) => {
    try {
      const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
      return result.status === 0 ? String(result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  };
  if (process.platform === "win32") {
    for (const line of lines("py", ["-0p"])) {
      const match = /([A-Za-z]:\\.+python\.exe)\s*$/i.exec(line);
      if (match) candidates.push({ command: match[1], prefixArgs: [] });
    }
    for (const found of lines("where.exe", ["python"])) {
      if (!/\\WindowsApps\\/i.test(found)) candidates.push({ command: found, prefixArgs: [] });
    }
  } else {
    candidates.push({ command: "python", prefixArgs: [] });
  }
  const uvPython = lines("uv", ["python", "find"])[0];
  if (uvPython) candidates.push({ command: uvPython, prefixArgs: [] });

  for (const candidate of candidates) {
    const probe = lines(candidate.command, [...candidate.prefixArgs, "-c", "import sys, venv; print(sys.version_info[0])"]);
    if (probe[0] === "3") {
      cachedBasePython = candidate;
      return candidate;
    }
  }
  return fallback;
}

function containsPythonTestFile(rootPath: string): boolean {
  const ignored = new Set([".git", ".venv", "venv", "node_modules", "dist", "build", "__pycache__"]);
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
      if (entry.name.startsWith(".")) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) stack.push(entryPath);
        continue;
      }
      if (/^(?:test_.*|.*_test)\.py$/i.test(entry.name)) return true;
    }
  }
  return false;
}

function containsPythonSourceFile(rootPath: string): boolean {
  const ignored = new Set([".git", ".venv", "venv", "node_modules", "dist", "build", "__pycache__"]);
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
      if (entry.name.startsWith(".")) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".py")) return true;
    }
  }
  return false;
}

function nestedProjectCommandSpecs(workspacePath: string, request: ValidationRequest): CommandSpec[] {
  const frontendDir = findAppDir(workspacePath, FRONTEND_DIR, "frontend");
  const backendDir = findAppDir(workspacePath, BACKEND_DIR, "backend");
  const appDirs = [frontendDir, backendDir].filter((dir): dir is string => dir !== null);
  const typescriptBin = resolveRuntimeTool(workspacePath, "typescript", "bin/tsc", appDirs);
  const vitestEntry = resolveRuntimeTool(workspacePath, "vitest", "vitest.mjs", appDirs);
  const viteEntry = resolveRuntimeTool(workspacePath, "vite", "bin/vite.js", appDirs);
  const backendTsconfig = firstExistingPath(workspacePath, [
    ...(backendDir ? [`${backendDir}/tsconfig.json`] : []),
    "tsconfig.json"
  ]);
  const uiTsconfig = firstExistingPath(workspacePath, [
    ...(frontendDir ? [`${frontendDir}/tsconfig.json`] : []),
    "ui/tsconfig.json",
    "tsconfig.ui.json"
  ]);
  const uiViteConfig = firstExistingPath(workspacePath, [
    ...(frontendDir ? [`${frontendDir}/vite.config.ts`, `${frontendDir}/vite.config.js`] : []),
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
      skipReason: backendTsconfig ? undefined : "no backend tsconfig found"
    },
    {
      id: "typecheck_ui",
      command: process.execPath,
      args: uiTsconfig
        ? [typescriptBin, "--noEmit", "-p", uiTsconfig]
        : [],
      timeoutMs: 120_000,
      skipReason: uiTsconfig ? undefined : "no frontend tsconfig found"
    },
    {
      id: testId,
      command: process.execPath,
      args: [vitestEntry, "run", ...tests],
      timeoutMs: tests.length > 0 ? 120_000 : 300_000,
      skipReason: hasTests ? undefined : "no test files found"
    },
    {
      id: "build_ui",
      command: process.execPath,
      args: uiViteConfig
        ? [viteEntry, "build", "--config", uiViteConfig]
        : [],
      timeoutMs: 180_000,
      skipReason: uiViteConfig ? undefined : "No frontend Vite configuration was found"
    },
    // A Python service next to the frontend (e.g. FastAPI + `frontend-ts/`)
    // was never compiled or tested in this layout.
    ...(hasPythonProject(workspacePath)
      ? pythonProjectCommandSpecs(workspacePath, { ...request, mode: "full", focusedTests: [] })
        .slice(1)
        .map((spec): CommandSpec => (spec.id === "tests_full" ? { ...spec, id: "tests_python" } : spec))
      : [])
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

function resolveRuntimeTool(
  workspacePath: string,
  packageName: string,
  relativePath: string,
  appDirs: string[] = []
): string {
  const roots = [
    workspacePath,
    // A nested frontend/backend installs its own tooling (`frontend-ts/node_modules/vite`).
    ...appDirs.map((dir) => path.join(workspacePath, ...dir.split("/"))),
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

function validatedFocusedTests(values: string[] | undefined, language: "typescript" | "python" = "typescript"): string[] {
  const tests = [...new Set(values ?? [])].map((value) => value.replaceAll("\\", "/"));
  const allowed = language === "python"
    ? /^(?:test|tests)\/[a-z0-9_.\/-]+\.py$/i
    : ALLOWED_FOCUSED_TEST;
  if (tests.some((value) => !allowed.test(value) || value.split("/").some((part) => part === ".." || part === "." || part === ""))) {
    throw new Error(language === "python"
      ? "Focused Python tests must be repository-relative test/ or tests/ *.py paths."
      : "Focused tests must be repository-relative test/*.test.ts paths.");
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
    signal,
    // Project test commands execute arbitrary project code. They must not
    // inherit Maestro's Telegram, provider, or application credentials.
    env: buildRestrictedAgentEnvironment(process.env)
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

// ── Environment preparation ─────────────────────────────────────────────

const PYTHON_REQUIREMENT_FILES = ["requirements.txt", "requirements-dev.txt", "requirements-test.txt"];
const PYTHON_DEPS_MARKER = ".maestro-deps.sha256";
const INSTALL_TIMEOUT_MS = 10 * 60_000;

type PreparationStep = { label: string; command: string; args: string[]; cwd: string; timeoutMs: number };

/**
 * Make the worktree runnable before the checks:
 * a `.venv` with the Python manifest installed (plus pytest when there are
 * tests), and a lockfile-aware package-manager install for every app directory
 * missing `node_modules`. Git's info/exclude can be shared by linked worktrees;
 * additions are logged. Re-installation only happens when manifests change.
 */
async function prepareEnvironment(
  executeProcess: typeof runAgentProcess,
  workspacePath: string,
  invocationRoot: string,
  invocationKey: string,
  signal: AbortSignal | undefined
): Promise<ValidationCheckResult> {
  const startedAt = Date.now();
  const log: string[] = [];
  const actions: string[] = [];
  const failures: string[] = [];

  const environmentsExcluded = excludeLocalEnvironments(workspacePath, log);
  if (!environmentsExcluded) {
    failures.push("could not guarantee generated environments stay out of commits; skipped dependency installation");
  }

  const run = async (step: PreparationStep): Promise<boolean> => {
    actions.push(step.label);
    const result = await executeProcess({
      command: step.command,
      args: step.args,
      cwd: step.cwd,
      timeoutMs: step.timeoutMs,
      maxOutputChars: RAW_OUTPUT_MAX_CHARS,
      signal,
      // npm/pip lifecycle hooks and project-defined build steps are untrusted
      // code; do not expose Maestro-owned credentials to them.
      env: buildRestrictedAgentEnvironment(process.env)
    });
    const output = redactSensitiveText([result.stdout, result.stderr].filter(Boolean).join("\n").trim());
    log.push(`$ ${step.label}\n${output}`);
    const passed = result.exitCode === 0 && !result.timedOut && !result.aborted;
    if (!passed) {
      failures.push(compactCommandFailure(
        output,
        `${step.label}: ${result.timedOut ? "timed out" : result.aborted ? "cancelled" : `exit ${result.exitCode ?? "unknown"}`}`
      ));
    }
    return passed;
  };

  if (environmentsExcluded) {
    if (hasPythonProject(workspacePath)) {
      await preparePython(workspacePath, run, log, failures);
    }
    for (const appDir of nodeAppDirs(workspacePath)) {
      if (signal?.aborted) break;
      await prepareNode(workspacePath, appDir, run, log, failures);
    }
  }

  const artifactKey = path.posix.join(invocationKey, "prepare_environment.raw.txt");
  fs.writeFileSync(path.join(invocationRoot, "prepare_environment.raw.txt"), log.join("\n\n"), "utf8");
  return {
    id: "prepare_environment",
    status: failures.length === 0 ? "passed" : "failed",
    durationMs: Date.now() - startedAt,
    summary: failures.length > 0
      ? truncateForDisplay(failures.join(" | "), COMPACT_FAILURE_MAX_CHARS)
      : actions.length > 0
        ? `prepared: ${actions.join("; ")}`
        : "nothing to prepare",
    artifactKey
  };
}

async function preparePython(
  workspacePath: string,
  run: (step: PreparationStep) => Promise<boolean>,
  log: string[],
  failures: string[]
): Promise<void> {
  const unsupportedManifests = ["Pipfile", "environment.yml"]
    .filter((file) => fs.existsSync(path.join(workspacePath, file)));
  if (unsupportedManifests.length > 0) {
    const message = `automatic Python preparation does not support ${unsupportedManifests.join(", ")}; use requirements*.txt or pyproject.toml`;
    log.push(message);
    failures.push(message);
    return;
  }
  const venvDir = path.join(workspacePath, ".venv");
  const venvPython = process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
  let created = false;
  if (!fs.existsSync(venvPython)) {
    const base = resolveBasePython();
    const ok = await run({
      label: "create .venv",
      command: base.command,
      args: [...base.prefixArgs, "-m", "venv", ".venv"],
      cwd: workspacePath,
      timeoutMs: 180_000
    });
    if (!ok) return;
    created = true;
  }

  const manifests = [...PYTHON_REQUIREMENT_FILES, "pyproject.toml", "setup.py", "setup.cfg"]
    .filter((file) => fs.existsSync(path.join(workspacePath, file)));
  const hash = crypto.createHash("sha256");
  for (const file of manifests) hash.update(file).update(fs.readFileSync(path.join(workspacePath, file)));
  const digest = hash.digest("hex");
  const markerPath = path.join(venvDir, PYTHON_DEPS_MARKER);
  const previous = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8").trim() : null;
  if (!created && previous === digest) {
    log.push("python dependencies unchanged since the last preparation");
    return;
  }

  const pip = ["-m", "pip", "install", "--disable-pip-version-check"];
  const requirements = PYTHON_REQUIREMENT_FILES.filter((file) => manifests.includes(file));
  let ok = true;
  if (requirements.length > 0) {
    for (const file of requirements) {
      ok = await run({ label: `pip install -r ${file}`, command: venvPython, args: [...pip, "-r", file], cwd: workspacePath, timeoutMs: INSTALL_TIMEOUT_MS }) && ok;
    }
  } else if (manifests.some((file) => ["pyproject.toml", "setup.py", "setup.cfg"].includes(file))) {
    const extras = fs.existsSync(path.join(workspacePath, "pyproject.toml"))
      ? pythonTestExtras(path.join(workspacePath, "pyproject.toml"))
      : [];
    const target = extras.length > 0 ? `.[${extras.join(",")}]` : ".";
    ok = await run({
      label: `pip install -e ${target}`,
      command: venvPython,
      args: [...pip, "-e", target],
      cwd: workspacePath,
      timeoutMs: INSTALL_TIMEOUT_MS
    });
  }
  if (containsPythonTestFile(workspacePath)) {
    ok = await run({ label: "pip install pytest", command: venvPython, args: [...pip, "pytest"], cwd: workspacePath, timeoutMs: INSTALL_TIMEOUT_MS }) && ok;
  }
  if (ok && fs.existsSync(venvDir)) {
    try {
      fs.writeFileSync(markerPath, `${digest}\n`, "utf8");
    } catch (error) {
      const message = `could not record the successful Python dependency preparation: ${error instanceof Error ? error.message : "unknown error"}`;
      log.push(message);
      failures.push(message);
    }
  }
}

function pythonTestExtras(pyprojectPath: string): string[] {
  const lines = fs.readFileSync(pyprojectPath, "utf8").split(/\r?\n/);
  const header = lines.findIndex((line) => line.trim() === "[project.optional-dependencies]");
  if (header < 0) return [];
  const section: string[] = [];
  for (const line of lines.slice(header + 1)) {
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) break;
    section.push(line);
  }
  return section
    .map((line) => /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name))
    .filter((name) => /^(?:dev|test|tests|testing)(?:[-_][A-Za-z0-9_-]+)?$/i.test(name));
}

/** The workspace root and first-level app folders that declare a package.json. */
function nodeAppDirs(workspacePath: string): string[] {
  const dirs = fs.existsSync(path.join(workspacePath, "package.json")) ? ["."] : [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(workspacePath, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (fs.existsSync(path.join(workspacePath, entry.name, "package.json"))) dirs.push(entry.name);
  }
  return dirs;
}

async function prepareNode(
  workspacePath: string,
  appDir: string,
  run: (step: PreparationStep) => Promise<boolean>,
  log: string[],
  failures: string[]
): Promise<void> {
  const cwd = path.join(workspacePath, ...appDir.split("/"));
  if (!declaresDependencies(path.join(cwd, "package.json"))) return; // nothing to install, never creates node_modules
  const packageManager = detectNodePackageManager(cwd);
  const manifestPaths = ["package.json", ...(packageManager?.lockfiles ?? [])]
    .map((file) => path.join(cwd, file))
    .filter((file) => fs.existsSync(file));
  const dependencyHash = crypto.createHash("sha256");
  for (const file of manifestPaths) dependencyHash.update(path.basename(file)).update(fs.readFileSync(file));
  const digest = dependencyHash.digest("hex");
  const nodeModules = path.join(cwd, "node_modules");
  const marker = path.join(nodeModules, ".maestro-deps.sha256");
  let previous: string | null = null;
  try {
    if (fs.existsSync(marker)) previous = fs.readFileSync(marker, "utf8").trim();
  } catch {
    log.push(`could not read the Node dependency preparation marker in ${appDir}; retrying installation`);
  }
  if (fs.existsSync(nodeModules) && previous === digest) {
    log.push(`Node dependencies unchanged since the last preparation in ${appDir}`);
    return;
  }
  const manager = packageManager ?? detectNpmWithoutLockfile();
  if (!manager) {
    const message = `no supported package manager was found for ${appDir}; dependencies were not installed`;
    log.push(message);
    failures.push(message);
    return;
  }
  const where = appDir === "." ? "" : ` in ${appDir}`;
  const installed = await run({
    label: `${manager.label}${where}`,
    command: manager.command,
    args: manager.args,
    cwd,
    timeoutMs: INSTALL_TIMEOUT_MS
  });
  const verified = installed && manager.npmCli
    ? await run({
      label: `npm dependency verification${where}`,
      command: process.execPath,
      args: [manager.npmCli, "ls", "--depth=0", "--no-audit", "--no-fund"],
      cwd,
      timeoutMs: 120_000
    })
    : installed;
  if (verified && fs.existsSync(nodeModules)) {
    try {
      fs.writeFileSync(marker, `${digest}\n`, "utf8");
    } catch (error) {
      const message = `could not record the successful Node dependency preparation in ${appDir}: ${error instanceof Error ? error.message : "unknown error"}`;
      log.push(message);
      failures.push(message);
    }
  }
}

type NodeManager = {
  label: string;
  lockfiles: string[];
  command: string;
  args: string[];
  npmCli?: string;
};

function detectNodePackageManager(cwd: string): NodeManager | null {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
    return {
      label: "pnpm install --frozen-lockfile",
      lockfiles: ["pnpm-lock.yaml"],
      ...commandForManager("pnpm", ["install", "--frozen-lockfile"])
    };
  }
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) {
    return {
      label: "yarn install --frozen-lockfile",
      lockfiles: ["yarn.lock"],
      ...commandForManager("yarn", ["install", "--frozen-lockfile"])
    };
  }
  const bunLockfiles = ["bun.lock", "bun.lockb"].filter((file) => fs.existsSync(path.join(cwd, file)));
  if (bunLockfiles.length > 0) {
    return {
      label: "bun install --frozen-lockfile",
      lockfiles: bunLockfiles,
      ...commandForManager("bun", ["install", "--frozen-lockfile"])
    };
  }
  if (fs.existsSync(path.join(cwd, "package-lock.json"))) {
    const npmCli = resolveNpmCli();
    return npmCli ? {
      label: "npm ci",
      lockfiles: ["package-lock.json"],
      command: process.execPath,
      args: [npmCli, "ci", "--no-audit", "--no-fund"],
      npmCli
    } : null;
  }
  return null;
}

function detectNpmWithoutLockfile(): NodeManager | null {
  const npmCli = resolveNpmCli();
  return npmCli ? {
    label: "npm install --no-package-lock",
    lockfiles: [],
    command: process.execPath,
    args: [npmCli, "install", "--no-package-lock", "--no-audit", "--no-fund"],
    npmCli
  } : null;
}

function commandForManager(name: "pnpm" | "yarn" | "bun", args: string[]): Pick<NodeManager, "command" | "args"> {
  // Windows package managers are commonly installed as .cmd shims. The
  // command string is static and arguments are fixed flags (never user data).
  return process.platform === "win32"
    ? { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `${name} ${args.join(" ")}`] }
    : { command: name, args };
}

function declaresDependencies(packageJsonPath: string): boolean {
  try {
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "optionalDependencies"].some((key) => {
      const value = manifest[key];
      return typeof value === "object" && value !== null && Object.keys(value).length > 0;
    });
  } catch {
    return true; // unreadable manifest: let npm report the problem
  }
}

function resolveNpmCli(): string | null {
  const bundled = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(bundled)) return bundled;
  const lookup = process.platform === "win32"
    ? spawnSync("where.exe", ["npm.cmd"], { encoding: "utf8", windowsHide: true, timeout: 10_000 })
    : spawnSync("which", ["npm"], { encoding: "utf8", timeout: 10_000 });
  for (const found of String(lookup.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const real = (() => {
      try {
        return fs.realpathSync(found);
      } catch {
        return found;
      }
    })();
    const candidates = [
      path.join(path.dirname(real), "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(path.dirname(real), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(path.dirname(real), "npm-cli.js")
    ];
    const hit = candidates.find((candidate) => fs.existsSync(candidate));
    if (hit) return hit;
  }
  return null;
}

/** Keep provisioned environments out of commits via Git's repository exclude file. */
function excludeLocalEnvironments(workspacePath: string, log: string[]): boolean {
  const lookup = spawnSync("git", ["-C", workspacePath, "rev-parse", "--git-path", "info/exclude"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000
  });
  const relative = String(lookup.stdout ?? "").trim();
  if (lookup.status !== 0 || !relative) {
    log.push("could not locate the Git exclude file; .venv/node_modules were not excluded");
    return false;
  }
  const excludePath = path.resolve(workspacePath, relative);
  try {
    const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    const patterns = [".venv/", "node_modules/", "__pycache__/", ".pytest_cache/"];
    const ignoredPath = (pattern: string) => `${pattern.slice(0, -1)}/.maestro-ignore-probe`;
    const missing = patterns.filter((pattern) => {
      const result = spawnSync("git", ["-C", workspacePath, "check-ignore", "--quiet", ignoredPath(pattern)], {
        encoding: "utf8", windowsHide: true, timeout: 30_000
      });
      return result.status !== 0 && !current.split(/\r?\n/).includes(pattern);
    });
    if (missing.length > 0) {
      fs.mkdirSync(path.dirname(excludePath), { recursive: true });
      const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
      fs.appendFileSync(excludePath, `${prefix}# Added by Maestro validation (shared Git exclude)\n${missing.join("\n")}\n`, "utf8");
      log.push("Updated the repository's shared Git info/exclude so generated environments stay out of commits.");
    }
    const safe = patterns.every((pattern) => spawnSync("git", ["-C", workspacePath, "check-ignore", "--quiet", ignoredPath(pattern)], {
      encoding: "utf8", windowsHide: true, timeout: 30_000
    }).status === 0);
    if (!safe) log.push("could not verify Git excludes for generated environments");
    return safe;
  } catch (error) {
    log.push(`could not write Git excludes for generated environments: ${error instanceof Error ? error.message : "unknown error"}`);
    return false;
  }
}
