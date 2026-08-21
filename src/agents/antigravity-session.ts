import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { buildRestrictedAgentEnvironment } from "./process.js";
import { resolveAntigravityExecutable } from "./antigravity.js";

/**
 * The Antigravity quota RPC is exposed by the CLI language server, not by the
 * authentication probe. `agy --continue` is the supported no-new-prompt mode
 * that keeps that server alive while the dashboard is being used.
 *
 * This manager deliberately owns at most one CLI process per Maestro process,
 * never sends a model prompt, and stops the managed process after a period of
 * dashboard inactivity so quota visibility cannot turn into a permanent RAM
 * leak.
 */

const AGY_START_TIMEOUT_MS = 8_000;
const AGY_START_RETRY_BACKOFF_MS = 30_000;
const AGY_IDLE_TIMEOUT_MS = 5 * 60_000;

let managedChild: ChildProcess | null = null;
let startPromise: Promise<boolean> | null = null;
let lastStartFailureAt = 0;
let idleTimer: NodeJS.Timeout | null = null;

export function findAgyLoopbackPort(): number[] {
  try {
    const sbin = execFileSync("netstat", ["-ano"], {
      encoding: "utf8",
      timeout: 1_500,
      windowsHide: true
    }).toString();
    const byPid = new Map<number, number[]>();
    for (const line of sbin.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
      if (!m) continue;
      const pid = Number(m[2]);
      if (!byPid.has(pid)) byPid.set(pid, []);
      byPid.get(pid)!.push(Number(m[1]));
    }

    // `tasklist` can briefly stall while the CLI is initializing. Keep this
    // bounded: a slow process inspection must never block /api/quota forever.
    const task = execFileSync("tasklist", ["/FO", "CSV", "/NH"], {
      encoding: "utf8",
      timeout: 1_500,
      windowsHide: true
    }).toString();
    for (const line of task.split(/\r?\n/)) {
      if (!/agy\.exe/i.test(line)) continue;
      const pidMatch = line.match(/"(\d+)"/);
      if (pidMatch && byPid.has(Number(pidMatch[1]))) return byPid.get(Number(pidMatch[1]))!;
    }
  } catch {
    return [];
  }
  return [];
}

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function scheduleIdleStop(): void {
  clearIdleTimer();
  if (!managedChild) return;
  idleTimer = setTimeout(() => {
    stopAntigravitySession();
  }, AGY_IDLE_TIMEOUT_MS);
  idleTimer.unref?.();
}

async function waitForAgyLoopback(child: ChildProcess, deadlineAt?: number): Promise<boolean> {
  const deadline = Math.min(Date.now() + AGY_START_TIMEOUT_MS, deadlineAt ?? Number.POSITIVE_INFINITY);
  while (Date.now() < deadline) {
    if (findAgyLoopbackPort().length > 0) return true;
    if (child.exitCode !== null || child.killed) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return findAgyLoopbackPort().length > 0;
}

export async function ensureAntigravitySession(deadlineAt?: number): Promise<boolean> {
  if (findAgyLoopbackPort().length > 0) {
    // An existing session may belong to the user's CLI or another Maestro
    // process. We can reuse it, but only reap children that this manager owns.
    return true;
  }
  if (managedChild && managedChild.exitCode === null && !managedChild.killed) {
    return waitForAgyLoopback(managedChild, deadlineAt);
  }
  if (startPromise) return startPromise;
  if (Date.now() - lastStartFailureAt < AGY_START_RETRY_BACKOFF_MS) return false;

  const executable = resolveAntigravityExecutable();
  if (!executable) return false;

  startPromise = (async () => {
    try {
      const child = spawn(executable, ["--continue"], {
        cwd: process.cwd(),
        env: buildRestrictedAgentEnvironment(process.env, { allowProviderKeys: true }),
        stdio: "ignore",
        detached: false,
        windowsHide: true
      });
      managedChild = child;
      child.once("exit", () => {
        if (managedChild === child) managedChild = null;
        clearIdleTimer();
      });
      child.once("error", () => {
        if (managedChild === child) managedChild = null;
        clearIdleTimer();
      });

      const active = await waitForAgyLoopback(child, deadlineAt);
      if (!active) {
        child.kill();
        lastStartFailureAt = Date.now();
        if (managedChild === child) managedChild = null;
        return false;
      }
      scheduleIdleStop();
      return true;
    } catch {
      lastStartFailureAt = Date.now();
      managedChild = null;
      return false;
    }
  })();

  try {
    return await startPromise;
  } finally {
    startPromise = null;
  }
}

export function touchAntigravitySession(): void {
  if (managedChild) scheduleIdleStop();
}

export function stopAntigravitySession(): void {
  clearIdleTimer();
  const child = managedChild;
  managedChild = null;
  if (child && child.exitCode === null && !child.killed) child.kill();
}

process.once("exit", stopAntigravitySession);
