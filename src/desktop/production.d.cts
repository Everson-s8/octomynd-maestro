export const DEFAULT_HOST: string;
export const DEFAULT_PORT: number;

export interface DesktopRuntimePaths {
  appRoot: string;
  backendEntry: string;
  uiDist: string;
}

export function resolveDesktopRuntimePaths(input: {
  isPackaged: boolean;
  appPath: string;
  cwd?: string;
}): DesktopRuntimePaths;

export function resolveDataDir(input: {
  userData: string;
  env?: Record<string, string | undefined>;
}): string;

export interface BackendSpawnConfig {
  command: string;
  args: string[];
  options: {
    cwd: string;
    env: Record<string, string>;
    windowsHide: boolean;
  };
  host: string;
  port: number;
}

export function buildBackendSpawnConfig(input: {
  execPath: string;
  backendEntry: string;
  uiDist: string;
  runtimeRoot?: string;
  dataDir: string;
  host?: string;
  port?: string | number;
  env?: Record<string, string | undefined>;
}): BackendSpawnConfig;

export interface EnvSeedPlan {
  shouldSeed: boolean;
  target: string;
  template: string;
}

export function resolveEnvSeedPlan(input: {
  dataDir: string;
  templatePath: string;
  fsExists: (path: string) => boolean;
}): EnvSeedPlan;

export function resolveLoadUrl(host: string, port: string | number): string;

export function resolveReleaseChannel(env: Record<string, string | undefined>): "dev" | "prod";

export function normalizePort(value: unknown, fallback: number): number;
