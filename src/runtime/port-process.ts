import { execFile } from "node:child_process";

export type ProcessRunner = (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** Parses `netstat -ano` output on Windows to find the PID listening on `port`. */
export function parseWindowsNetstatOutput(output: string, port: number): string | null {
  const needle = `:${port}`;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("TCP")) continue;
    const columns = trimmed.split(/\s+/);
    if (columns.length < 5) continue;
    const [, localAddress, , state, pid] = columns;
    if (!localAddress.endsWith(needle)) continue;
    if (state !== "LISTENING") continue;
    if (pid && /^\d+$/.test(pid)) return pid;
  }
  return null;
}

/** Parses `lsof -nP -iTCP:<port> -sTCP:LISTEN` output on POSIX to find the owning PID. */
export function parsePosixLsofOutput(output: string): string | null {
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const line of lines.slice(1)) {
    const columns = line.trim().split(/\s+/);
    const pid = columns[1];
    if (pid && /^\d+$/.test(pid)) return pid;
  }
  return null;
}

async function defaultRunner(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/** Finds the PID of the process listening on `port`, or null if none is found. */
export async function findProcessOnPort(
  port: number,
  platform: NodeJS.Platform = process.platform,
  runner: ProcessRunner = defaultRunner
): Promise<string | null> {
  if (platform === "win32") {
    const result = await runner("netstat", ["-ano"]);
    if (!result.ok) return null;
    return parseWindowsNetstatOutput(result.stdout, port);
  }
  const result = await runner("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  if (!result.ok) return null;
  return parsePosixLsofOutput(result.stdout);
}

/** Sends a graceful termination signal to `pid`, then force-kills after `graceMs` if it is still alive. */
export async function killProcessGracefully(
  pid: string,
  platform: NodeJS.Platform = process.platform,
  runner: ProcessRunner = defaultRunner,
  graceMs = 3000,
  isAlive: (pid: string) => boolean = (p) => processIsAlive(p)
): Promise<void> {
  if (platform === "win32") {
    await runner("taskkill", ["/PID", pid, "/T"]);
  } else {
    await runner("kill", ["-TERM", pid]);
  }

  const pollIntervalMs = Math.min(100, graceMs);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  if (platform === "win32") {
    await runner("taskkill", ["/PID", pid, "/T", "/F"]);
  } else {
    await runner("kill", ["-KILL", pid]);
  }
}

function processIsAlive(pid: string): boolean {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}
