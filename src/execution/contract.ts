import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const EXPECTED_NODE_VERSION = "20.17.0";
export const SUPPORTED_NODE_RANGE = ">=20.17.0 <21";

export type ExecutionContract = {
  rootPath: string;
  worktreesPath: string;
  expectedNodeVersion: string;
  supportedNodeRange: string;
};

export type ExecutionPathAssessment = {
  ready: boolean;
  reasons: string[];
  underUserProfile: boolean;
  cloudSynced: boolean;
};

export type ExecutableFingerprint = {
  name: string;
  available: boolean;
  version: string | null;
  pathHash: string | null;
};

export type EnvironmentFingerprint = {
  id: string;
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  node: {
    version: string;
    executableHash: string;
    supported: boolean;
  };
  tools: ExecutableFingerprint[];
  paths: {
    executionRootHash: string;
    worktreesRootHash: string;
    outsideUserProfile: boolean;
    cloudSynced: boolean;
  };
};

export type ExecutionContractMarker = {
  schemaVersion: 1;
  expectedNodeVersion: string;
  supportedNodeRange: string;
  worktreesDirectory: "worktrees";
};

export function resolveExecutionContract(
  cwd: string,
  projectName: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): ExecutionContract {
  const pathApi = platform === "win32" ? path.win32 : path;
  const configuredRoot = env.MAESTRO_EXECUTION_ROOT?.trim();
  const defaultRoot = platform === "win32"
    ? pathApi.join(env.SystemDrive?.trim() || "C:\\", "MaestroRuntime", slugify(projectName))
    : path.resolve(cwd, ".maestro", "execution");
  const rootPath = pathApi.resolve(cwd, configuredRoot || defaultRoot);
  const configuredWorktrees = env.MAESTRO_WORKTREES_PATH?.trim();

  return {
    rootPath,
    worktreesPath: pathApi.resolve(cwd, configuredWorktrees || pathApi.join(rootPath, "worktrees")),
    expectedNodeVersion: env.MAESTRO_NODE_VERSION?.trim() || EXPECTED_NODE_VERSION,
    supportedNodeRange: SUPPORTED_NODE_RANGE
  };
}

export function assessExecutionPaths(
  contract: Pick<ExecutionContract, "rootPath" | "worktreesPath">,
  env: NodeJS.ProcessEnv = process.env
): ExecutionPathAssessment {
  const reasons: string[] = [];
  const userProfile = env.USERPROFILE?.trim() || os.homedir();
  const underUserProfile = isPathWithin(contract.rootPath, userProfile)
    || isPathWithin(contract.worktreesPath, userProfile);
  const cloudSynced = [contract.rootPath, contract.worktreesPath].some(isCloudSyncedPath);

  if (underUserProfile) reasons.push("Execution roots must stay outside the user profile.");
  if (cloudSynced) reasons.push("Execution roots must stay outside cloud-synced folders.");
  const pathApi = pathApiFor(contract.rootPath, contract.worktreesPath);
  if (pathApi.parse(contract.rootPath).root === pathApi.resolve(contract.rootPath)) {
    reasons.push("Execution root cannot be the filesystem root.");
  }
  if (!isPathWithin(contract.worktreesPath, contract.rootPath)) {
    reasons.push("Worktrees root must be contained by the execution root.");
  }

  return { ready: reasons.length === 0, reasons, underUserProfile, cloudSynced };
}

export function captureEnvironmentFingerprint(
  contract: ExecutionContract,
  env: NodeJS.ProcessEnv = process.env
): EnvironmentFingerprint {
  const assessment = assessExecutionPaths(contract, env);
  const tools = [
    fingerprintExecutable("npm", ["--version"], env),
    fingerprintExecutable("git", ["--version"], env),
    fingerprintExecutable("codex", ["--version"], env),
    fingerprintExecutable("claude", ["--version"], env)
  ];
  const fingerprint = {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    node: {
      version: process.version,
      executableHash: hashPath(process.execPath),
      supported: isSupportedNodeVersion(process.version, contract.expectedNodeVersion)
    },
    tools,
    paths: {
      executionRootHash: hashPath(contract.rootPath),
      worktreesRootHash: hashPath(contract.worktreesPath),
      outsideUserProfile: !assessment.underUserProfile,
      cloudSynced: assessment.cloudSynced
    }
  };

  return {
    id: crypto.createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex").slice(0, 16),
    ...fingerprint
  };
}

export function ensureExecutionContract(contract: ExecutionContract): ExecutionContractMarker {
  const assessment = assessExecutionPaths(contract);
  if (!assessment.ready) throw new Error(assessment.reasons.join(" "));
  fs.mkdirSync(contract.worktreesPath, { recursive: true });
  const marker: ExecutionContractMarker = {
    schemaVersion: 1,
    expectedNodeVersion: contract.expectedNodeVersion,
    supportedNodeRange: contract.supportedNodeRange,
    worktreesDirectory: "worktrees"
  };
  const markerPath = path.join(contract.rootPath, ".maestro-execution.json");
  const serialized = `${JSON.stringify(marker, null, 2)}\n`;
  if (!fs.existsSync(markerPath) || fs.readFileSync(markerPath, "utf8") !== serialized) {
    fs.writeFileSync(markerPath, serialized, "utf8");
  }
  return marker;
}

export function isSupportedNodeVersion(actual: string, expected = EXPECTED_NODE_VERSION): boolean {
  const actualParts = parseVersion(actual);
  const expectedParts = parseVersion(expected);
  return Boolean(
    actualParts
      && expectedParts
      && actualParts.major === expectedParts.major
      && actualParts.minor === expectedParts.minor
      && actualParts.patch >= expectedParts.patch
  );
}

export function isPathWithin(candidate: string, parent: string): boolean {
  const pathApi = pathApiFor(candidate, parent);
  const relative = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
}

function fingerprintExecutable(name: string, args: string[], env: NodeJS.ProcessEnv): ExecutableFingerprint {
  const executable = resolveExecutable(name, env);
  if (!executable) return { name, available: false, version: null, pathHash: null };
  const command = buildExecutableCommand(executable, args, env);
  const result = spawnSync(command.executable, command.args, {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 5_000
  });
  const version = [result.stdout, result.stderr].filter(Boolean).join(" ").trim().split(/\r?\n/)[0] || null;
  return {
    name,
    available: result.status === 0,
    version,
    pathHash: hashPath(executable)
  };
}

function buildExecutableCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv
): { executable: string; args: string[] } {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { executable, args };
  }
  return {
    executable: env.ComSpec?.trim() || "cmd.exe",
    args: ["/d", "/c", executable, ...args]
  };
}

function resolveExecutable(name: string, env: NodeJS.ProcessEnv): string | null {
  const pathEntries = (env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, process.platform === "win32" ? `${name}${extension}` : name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.resolve(candidate);
    }
  }
  return null;
}

function isCloudSyncedPath(value: string): boolean {
  return /(?:^|[\\/])(?:onedrive|dropbox|google drive|icloud)(?:[\\/]|$)/i.test(value);
}

function hashPath(value: string): string {
  return crypto.createHash("sha256")
    .update(pathApiFor(value).resolve(value).toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

function pathApiFor(...values: string[]): typeof path.posix | typeof path.win32 {
  return values.some((value) => /^[A-Za-z]:[\\/]/.test(value)) ? path.win32 : path;
}

function parseVersion(value: string): { major: number; minor: number; patch: number } | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match
    ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
    : null;
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "maestro";
}
