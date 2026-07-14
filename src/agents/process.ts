import { spawn } from "node:child_process";

export type AgentProcessBreakerReason =
  | "inactivity"
  | "phase_timeout"
  | "deadline"
  | "duplicate_output"
  | "output_limit";

export type AgentProcessRequest = {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputChars?: number;
  maxReceivedChars?: number;
  maxDuplicateChunks?: number;
  inactivityTimeoutMs?: number;
  deadlineAt?: number;
  env?: NodeJS.ProcessEnv;
};

export type AgentProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  breakerReason: AgentProcessBreakerReason | null;
  outputStats: {
    receivedChars: number;
    retainedChars: number;
    duplicateChunks: number;
    truncatedChars: number;
  };
  durationMs: number;
};

export async function runAgentProcess(request: AgentProcessRequest): Promise<AgentProcessResult> {
  const startedAt = Date.now();
  const maxOutputChars = request.maxOutputChars ?? 500_000;
  const maxReceivedChars = request.maxReceivedChars ?? Math.max(maxOutputChars * 4, maxOutputChars);
  const maxDuplicateChunks = request.maxDuplicateChunks ?? 80;
  const inactivityTimeoutMs = request.inactivityTimeoutMs ?? Math.min(request.timeoutMs, 2 * 60_000);

  return new Promise((resolve) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      windowsHide: true,
      stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: request.env ?? process.env
    });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    let timedOut = false;
    let breakerReason: AgentProcessBreakerReason | null = null;
    let settled = false;
    let stopRequested = false;
    let receivedChars = 0;
    let duplicateChunks = 0;
    let consecutiveDuplicateChunks = 0;
    let lastChunkSignature = "";
    let inactivityTimer: NodeJS.Timeout | null = null;
    let phaseTimer: NodeJS.Timeout | null = null;
    let deadlineTimer: NodeJS.Timeout | null = null;
    let forceFinishTimer: NodeJS.Timeout | null = null;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (phaseTimer) clearTimeout(phaseTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (forceFinishTimer) clearTimeout(forceFinishTimer);
      request.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        stdout,
        stderr,
        aborted,
        timedOut,
        breakerReason,
        outputStats: {
          receivedChars,
          retainedChars: stdout.length + stderr.length,
          duplicateChunks,
          truncatedChars: Math.max(0, receivedChars - stdout.length - stderr.length)
        },
        durationMs: Date.now() - startedAt
      });
    };
    const stop = () => {
      if (stopRequested) return;
      stopRequested = true;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore"
        });
        killer.once("error", () => child.kill());
      } else if (!child.killed) {
        child.kill("SIGTERM");
      }
      forceFinishTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        finish(null);
      }, 2_000);
    };
    const tripBreaker = (reason: AgentProcessBreakerReason) => {
      if (breakerReason || settled) return;
      breakerReason = reason;
      timedOut = reason === "inactivity" || reason === "phase_timeout" || reason === "deadline";
      stop();
    };
    const resetInactivityTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (inactivityTimeoutMs > 0) {
        inactivityTimer = setTimeout(() => tripBreaker("inactivity"), inactivityTimeoutMs);
      }
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    phaseTimer = setTimeout(() => tripBreaker("phase_timeout"), request.timeoutMs);
    if (request.deadlineAt !== undefined) {
      deadlineTimer = setTimeout(
        () => tripBreaker("deadline"),
        Math.max(0, request.deadlineAt - Date.now())
      );
    }
    resetInactivityTimer();

    request.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    const consume = (stream: "stdout" | "stderr", chunk: string) => {
      if (settled) return;
      receivedChars += chunk.length;
      resetInactivityTimer();
      const signature = chunk.trim().replace(/\s+/g, " ");
      if (signature && signature === lastChunkSignature) {
        duplicateChunks += 1;
        consecutiveDuplicateChunks += 1;
      } else {
        lastChunkSignature = signature;
        consecutiveDuplicateChunks = 0;
        if (stream === "stdout") stdout = appendBounded(stdout, chunk, maxOutputChars);
        else stderr = appendBounded(stderr, chunk, maxOutputChars);
      }
      if (consecutiveDuplicateChunks >= maxDuplicateChunks) tripBreaker("duplicate_output");
      else if (receivedChars > maxReceivedChars) tripBreaker("output_limit");
    };
    child.stdout!.on("data", (chunk: string) => consume("stdout", chunk));
    child.stderr!.on("data", (chunk: string) => consume("stderr", chunk));
    child.on("error", (error) => {
      stderr = appendBounded(stderr, `\n${error.message}`, maxOutputChars).trim();
      finish(null);
    });
    child.on("close", finish);

    if (request.stdin !== undefined) child.stdin?.end(request.stdin);
    if (request.signal?.aborted) onAbort();
  });
}

export function buildRestrictedAgentEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isSensitiveEnvironmentKey(key)));
}

function isSensitiveEnvironmentKey(key: string): boolean {
  return /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|API_KEY|PRIVATE_KEY)(?:_|$)/i.test(key);
}

function appendBounded(current: string, chunk: string, maxChars: number): string {
  const next = current + chunk;
  return next.length <= maxChars ? next : next.slice(-maxChars);
}
