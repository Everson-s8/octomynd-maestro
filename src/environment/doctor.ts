import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentRegistry } from "../agents/registry.js";
import type { AgentHealth, AgentProviderId } from "../agents/types.js";
import type { MaestroConfig } from "../config.js";
import type { MaestroDatabase, ProjectRecord, TaskRecord } from "../db.js";
import {
  assessExecutionPaths,
  captureEnvironmentFingerprint,
  isPathWithin,
  isSupportedNodeVersion
} from "../execution/contract.js";
import { redactSensitiveText, truncateForDisplay } from "../security/redaction.js";
import type {
  EnvironmentCheck,
  EnvironmentDoctorReport,
  EnvironmentReadinessStatus
} from "./types.js";

type ProviderReadiness = { id: AgentProviderId; health: AgentHealth };

export type EnvironmentDoctorInput = {
  config: MaestroConfig;
  project: ProjectRecord;
  task?: TaskRecord | null;
  providers?: ProviderReadiness[];
  prepareDependencies?: boolean;
};

export class EnvironmentBlockedError extends Error {
  constructor(readonly report: EnvironmentDoctorReport) {
    super(report.summary);
    this.name = "EnvironmentBlockedError";
  }
}

export class EnvironmentDoctor {
  constructor(
    private readonly config: MaestroConfig,
    private readonly database: MaestroDatabase,
    private readonly registry: AgentRegistry
  ) {}

  preflightTask(taskId: number): EnvironmentDoctorReport {
    const task = this.database.getTask(taskId);
    if (!task.projectKey) throw new Error(`Task #${taskId} has no project.`);
    const report = runEnvironmentDoctor({
      config: this.config,
      project: this.database.getProjectByKey(task.projectKey),
      task,
      prepareDependencies: true
    });
    this.record(report);
    return report;
  }

  async inspectProject(projectKey: string): Promise<EnvironmentDoctorReport> {
    const providerSnapshot = await this.registry.snapshot();
    const report = runEnvironmentDoctor({
      config: this.config,
      project: this.database.getProjectByKey(projectKey),
      providers: providerSnapshot.map(({ id, health }) => ({ id, health }))
    });
    this.record(report);
    return report;
  }

  async inspectAll(): Promise<EnvironmentDoctorReport[]> {
    return Promise.all(this.database.listProjects().map((project) => this.inspectProject(project.key)));
  }

  private record(report: EnvironmentDoctorReport): void {
    this.database.addEvent({
      source: "maestro",
      type: "environment.doctor",
      text: report.summary,
      taskId: report.taskId,
      metadata: { projectKey: report.projectKey, report }
    });
  }
}

export function runEnvironmentDoctor(input: EnvironmentDoctorInput): EnvironmentDoctorReport {
  const workspacePath = input.task?.worktreePath || input.project.path;
  const packagedRuntime = process.env.MAESTRO_RUNTIME_MODE === "packaged";
  const hasProjectLockfile = fs.existsSync(path.join(workspacePath, "package-lock.json"));
  const checks: EnvironmentCheck[] = [];
  const fingerprint = captureEnvironmentFingerprint(input.config.execution);
  const pathAssessment = assessExecutionPaths(input.config.execution);
  checks.push(check(
    "execution_paths",
    pathAssessment.ready ? "passed" : "failed",
    pathAssessment.ready ? "Dedicated execution roots are safe." : pathAssessment.reasons.join(" "),
    pathAssessment.ready ? undefined : "environment_blocked"
  ));

  if (input.task?.worktreePath && !isPathWithin(input.task.worktreePath, input.config.worktreesPath)) {
    checks.push(check(
      "worktree",
      "failed",
      "Task worktree is outside the deterministic execution root.",
      "environment_blocked"
    ));
  } else {
    checks.push(check("worktree", fs.existsSync(workspacePath) ? "passed" : "failed",
      fs.existsSync(workspacePath) ? "Workspace is available." : "Workspace is missing.",
      fs.existsSync(workspacePath) ? undefined : "environment_blocked"));
  }

  checks.push(writeProbe(input.config.execution.rootPath, "temporary_write"));
  if (fs.existsSync(workspacePath)) checks.push(writeProbe(workspacePath, "worktree"));

  const git = runCommand("git", ["-C", workspacePath, "rev-parse", "--is-inside-work-tree"], workspacePath);
  checks.push(check("git", git.ok ? "passed" : "failed",
    git.ok ? "Git workspace is readable." : compactFailure(git.output),
    git.ok ? undefined : "environment_blocked"));

  checks.push(check("node", isSupportedNodeVersion(
    process.version,
    input.config.execution.expectedNodeVersion,
    input.config.execution.supportedNodeRange
  )
    ? "passed" : "failed",
  `Node ${process.version}; supported range ${input.config.execution.supportedNodeRange}.`,
  isSupportedNodeVersion(
    process.version,
    input.config.execution.expectedNodeVersion,
    input.config.execution.supportedNodeRange
  ) ? undefined : "environment_blocked"));

  if (packagedRuntime) {
    checks.push(check(
      "npm",
      "skipped",
      hasProjectLockfile
        ? "Packaged runtime does not install project dependencies; prepare this project's lockfile before running tasks."
        : "Packaged runtime provides its own deterministic toolchain; npm is not required."
    ));
  } else {
    const npm = runCommand("npm", ["--version"], workspacePath);
    checks.push(check("npm", npm.ok ? "passed" : "failed",
      npm.ok ? `npm ${npm.output.trim().split(/\r?\n/)[0]}.` : compactFailure(npm.output),
      npm.ok ? undefined : "environment_blocked"));
  }

  let dependencyRoot = findPreparedDependencyRoot(workspacePath, input.project.path);
  if (!packagedRuntime && !dependencyRoot && input.prepareDependencies && fs.existsSync(path.join(workspacePath, "package-lock.json"))) {
    const prepared = runCommand(
      "npm",
      ["ci", "--no-audit", "--no-fund"],
      workspacePath,
      600_000
    );
    if (!prepared.ok) {
      checks.push(check("npm", "failed", `Dependency preparation failed: ${compactFailure(prepared.output)}`, "environment_blocked"));
    } else if (process.platform === "win32") {
      // A stale npm cache can hand npm ci a better-sqlite3 prebuilt compiled against
      // a different NODE_MODULE_VERSION than the running node (e.g. a Node 22
      // prebuild), so the native probe below would fail. Force a rebuild of the
      // native module under this process's node right after install so the binding
      // always matches the supported runtime.
      runCommand("npm", ["rebuild", "better-sqlite3", "--no-audit", "--no-fund"], workspacePath, 300_000);
    }
    dependencyRoot = findPreparedDependencyRoot(workspacePath, input.project.path);
  }

  checks.push(nativeRuntimeCheck(dependencyRoot));
  checks.push(binaryCheck("typescript", dependencyRoot, executableName("tsc")));
  checks.push(binaryCheck("test_runner", dependencyRoot, executableName("vitest")));
  checks.push(providerCheck(input.providers));

  const status = classifyReport(checks, input.providers);
  const summary = summarize(status, checks);
  return {
    status,
    summary,
    recommendedAction: recommendedAction(status, checks),
    checkedAt: new Date().toISOString(),
    projectKey: input.project.key,
    taskId: input.task?.id ?? null,
    fingerprintId: fingerprint.id,
    requiredCapabilities: ["planning", "coding", "testing", "reviewing"],
    checks
  };
}

function nativeRuntimeCheck(dependencyRoot: string | null): EnvironmentCheck {
  if (!dependencyRoot) {
    return check("native_runtime", "failed", "Dependencies are unavailable for native runtime validation.", "environment_blocked");
  }
  const packageJsonPath = path.join(dependencyRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) return check("native_runtime", "skipped", "No package manifest requires a native runtime probe.");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const usesBetterSqlite = Boolean(packageJson.dependencies?.["better-sqlite3"] || packageJson.devDependencies?.["better-sqlite3"]);
  if (!usesBetterSqlite) return check("native_runtime", "skipped", "No allowlisted native dependency requires a probe.");
  const probe = runCommand(
    process.execPath,
    ["-e", "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close();"],
    dependencyRoot
  );
  // A stale npm cache may deliver a prebuilt binary compiled against a different
  // NODE_MODULE_VERSION (e.g. a Node 22 prebuild) than the runtime. Rebuild the
  // native module under this process's node before failing, so an ABI mismatch
  // is fixed rather than surfacing as a false environment_blocked.
  if (!probe.ok && process.platform === "win32") {
    const rebound = runCommand(
      "npm",
      ["rebuild", "better-sqlite3", "--no-audit", "--no-fund"],
      dependencyRoot,
      300_000
    );
    if (rebound.ok) {
      const reProbe = runCommand(
        process.execPath,
        ["-e", "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close();"],
        dependencyRoot
      );
      if (reProbe.ok) {
        return check("native_runtime", "passed", "better-sqlite3 native binding recomputed and loadable.");
      }
    }
  }
  return check(
    "native_runtime",
    probe.ok ? "passed" : "failed",
    probe.ok ? "better-sqlite3 native binding is loadable." : compactFailure(probe.output),
    probe.ok ? undefined : "environment_blocked"
  );
}

function check(
  name: EnvironmentCheck["name"],
  status: EnvironmentCheck["status"],
  summary: string,
  classification?: EnvironmentCheck["classification"]
): EnvironmentCheck {
  return {
    name,
    status,
    summary: truncateForDisplay(redactSensitiveText(summary), 240),
    classification,
    evidence: []
  };
}

function writeProbe(root: string, name: EnvironmentCheck["name"]): EnvironmentCheck {
  const probe = path.join(root, `.maestro-doctor-${process.pid}-${crypto.randomUUID()}`);
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(probe, "ok", "utf8");
    fs.rmSync(probe, { force: true });
    return check(name, "passed", name === "temporary_write"
      ? "Execution root is writable."
      : "Workspace write probe passed.");
  } catch (error) {
    try { fs.rmSync(probe, { force: true }); } catch {}
    return check(name, "failed", error instanceof Error ? error.message : "Write probe failed.", "environment_blocked");
  }
}

function binaryCheck(
  name: "typescript" | "test_runner",
  dependencyRoot: string | null,
  binary: string
): EnvironmentCheck {
  const available = Boolean(dependencyRoot && fs.existsSync(path.join(dependencyRoot, "node_modules", ".bin", binary)));
  return check(name, available ? "passed" : "failed",
    available ? `${name} is prepared.` : `${name} is unavailable; run deterministic dependency preparation.`,
    available ? undefined : "environment_blocked");
}

function providerCheck(providers: ProviderReadiness[] | undefined): EnvironmentCheck {
  if (!providers) return check("providers", "skipped", "Provider readiness is evaluated by routing.");
  const ready = providers.filter((provider) => provider.health.state === "ready");
  if (ready.length > 0) return check("providers", "passed", `${ready.map((item) => item.id).join(", ")} ready.`);
  const state = providers.some((item) => item.health.state === "auth_required")
    ? "auth_required"
    : providers.some((item) => item.health.state === "quota") ? "quota" : "offline";
  return check("providers", "failed", `No ready provider; classified as ${state}.`, state);
}

function classifyReport(
  checks: EnvironmentCheck[],
  providers: ProviderReadiness[] | undefined
): EnvironmentReadinessStatus {
  if (checks.some((item) => item.status === "failed" && item.classification === "environment_blocked")) {
    return "environment_blocked";
  }
  if (!providers || providers.some((item) => item.health.state === "ready")) return "ready";
  if (providers.some((item) => item.health.state === "auth_required")) return "auth_required";
  if (providers.some((item) => item.health.state === "quota")) return "quota";
  return "offline";
}

function summarize(status: EnvironmentReadinessStatus, checks: EnvironmentCheck[]): string {
  const failed = checks.filter((item) => item.status === "failed");
  return status === "ready"
    ? "Execution environment ready."
    : `Execution environment ${status}: ${failed.map((item) => item.name).join(", ") || "provider readiness"}.`;
}

function recommendedAction(status: EnvironmentReadinessStatus, checks: EnvironmentCheck[]): string {
  if (status === "ready") return "No action required.";
  if (status === "auth_required") return "Authenticate an available provider and retry.";
  if (status === "quota") return "Wait for provider quota reset or use another ready provider.";
  if (status === "offline") return "Restore provider connectivity before starting the Goal.";
  const failed = checks.find((item) => item.status === "failed");
  return failed ? `Fix ${failed.name}: ${failed.summary}` : "Fix the deterministic execution environment.";
}

function findPreparedDependencyRoot(workspacePath: string, projectPath: string): string | null {
  const workspaceRoot = path.resolve(workspacePath);

  // A task worktree with its own complete toolchain wins — self-development.
  if (isValidationDependencyRootComplete(workspaceRoot)) {
    return workspaceRoot;
  }

  // A Node project rooted at the worktree (has a lockfile at its root, e.g. the
  // Maestro repo itself) must prepare ITS OWN toolchain via `npm ci` — return
  // null so the caller runs npm ci and the freshly-installed toolchain is used.
  // We must NOT silently fall back to the daemon's older toolchain here, or a
  // self-development task that bumps tsc/vitest/better-sqlite3 would validate
  // against the wrong versions forever.
  if (fs.existsSync(path.join(workspaceRoot, "package-lock.json"))) {
    return null;
  }

  // Otherwise the worktree is a target project that is not a root-Node repo
  // (monorepo with the app in a subfolder, a Java/other-stack backend, etc.).
  // It does not need the Maestro toolchain installed in itself, so fall back to
  // the running Maestro runtime's node_modules so the goal is not blocked.
  const maestroRoot = process.cwd();
  const packagedRoot = process.env.MAESTRO_RUNTIME_ROOT?.trim();
  const maestroCandidates = [
    packagedRoot,
    maestroRoot,
    path.dirname(maestroRoot),
    findMatchingAncestor(maestroRoot)
  ];
  for (const candidate of maestroCandidates) {
    if (candidate && fs.existsSync(path.join(candidate, "node_modules", ".bin")) && isDependencyRootComplete(candidate)) {
      return candidate;
    }
  }

  // Last resort: a project ancestor with a complete toolchain, else null.
  let current = path.resolve(projectPath);
  while (true) {
    if (fs.existsSync(path.join(current, "node_modules", ".bin")) && isDependencyRootComplete(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Walk up from `start` and return the first ancestor that carries a complete
 * Maestro node_modules (tsc + vitest + better-sqlite3). Used to locate the
 * Maestro runtime toolchain when the process cwd sits inside a worktree.
 */
function findMatchingAncestor(start: string): string | null {
  let current = path.dirname(start);
  const root = path.parse(current).root;
  while (true) {
    if (current && isDependencyRootComplete(current)) return current;
    if (current === root) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The project validation toolchain is TypeScript + Vitest. better-sqlite3 is
 * checked only when the project actually declares it; external Node projects do
 * not need to carry Maestro's native database dependency just to be validated.
 */
function isDependencyRootComplete(root: string): boolean {
  if (!isValidationDependencyRootComplete(root)) return false;
  return hasLoadableNativeDependency(root, "better-sqlite3");
}

function isValidationDependencyRootComplete(root: string): boolean {
  const hasTsc = fs.existsSync(path.join(root, "node_modules", ".bin", executableName("tsc")));
  const hasVitest = fs.existsSync(path.join(root, "node_modules", ".bin", executableName("vitest")));
  if (!hasTsc || !hasVitest) return false;

  const packageJson = readPackageJson(root);
  const declaresBetterSqlite = Boolean(
    packageJson?.dependencies?.["better-sqlite3"] || packageJson?.devDependencies?.["better-sqlite3"]
  );
  return !declaresBetterSqlite || hasLoadableNativeDependency(root, "better-sqlite3");
}

function hasLoadableNativeDependency(root: string, dependency: string): boolean {
  const dependencyRoot = path.join(root, "node_modules", dependency);
  const platformTarget = `${process.platform}-${process.arch}`;
  const legacyBuild = path.join(dependencyRoot, "build", "Release", "better_sqlite3.node");
  const platformPrebuild = path.join(dependencyRoot, "prebuilds", `${platformTarget}.node`);
  const platformModule = path.join(dependencyRoot, "lib", `${platformTarget}.js`);
  const prebuildDirectory = path.join(dependencyRoot, "prebuilds");
  const hasAnyPrebuild = fs.existsSync(prebuildDirectory)
    && fs.readdirSync(prebuildDirectory).some((entry) => entry.endsWith(".node"));
  // better-sqlite3 publishes platform loaders alongside its prebuilds. Keep
  // the loader as a candidate signal for unusual package layouts; the later
  // nativeRuntimeCheck still performs the real require() probe.
  return fs.existsSync(legacyBuild)
    || fs.existsSync(platformPrebuild)
    || fs.existsSync(platformModule)
    || hasAnyPrebuild;
}

function readPackageJson(root: string): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} | null {
  try {
    const packageJsonPath = path.join(root, "package.json");
    if (!fs.existsSync(packageJsonPath)) return null;
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
  } catch {
    return null;
  }
}

function executableName(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function runCommand(command: string, args: string[], cwd: string, timeout = 15_000): { ok: boolean; output: string } {
  // On Windows, `npm.cmd` resolves whatever `node` is first on the inherited PATH,
  // which can be a different major version than the one this process runs (e.g. a
  // Node 22 shipped with another tool). Compiling native deps (better-sqlite3)
  // under the wrong node major fails or silently skips the binding, which then
  // shows up as a false `environment_blocked`. Pin npm to this process's own node
  // binary so the toolchain is always prepared under the supported runtime.
  const bundledNpmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const nodeBin = process.execPath;
  const invocation =
    process.platform === "win32"
      ? command === "npm"
        ? fs.existsSync(bundledNpmCli)
          ? { command: nodeBin, args: [bundledNpmCli, ...args] }
          : { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/c", executableName("npm"), ...args] }
        : command.endsWith(".cmd")
          ? { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/c", command, ...args] }
          : { command, args }
      : { command, args };
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    // Ensure this process's own node directory precedes any other on PATH, so
    // child tooling (npm node-gyp scripts, prebuild-install) resolves the same
    // supported node and does not pick up a different major from the host PATH.
    env: { ...process.env, PATH: [path.dirname(nodeBin), process.env.PATH].filter(Boolean).join(path.delimiter) },
    windowsHide: true,
    timeout
  });
  return {
    ok: result.status === 0,
    output: [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n").trim()
  };
}

function compactFailure(value: string): string {
  return truncateForDisplay(redactSensitiveText(value || "Command failed without output."), 200);
}
