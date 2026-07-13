import { spawn } from "node:child_process";

export type AgentProcessRequest = {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputChars?: number;
  env?: NodeJS.ProcessEnv;
};

export type AgentProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  durationMs: number;
};

export async function runAgentProcess(request: AgentProcessRequest): Promise<AgentProcessResult> {
  const startedAt = Date.now();
  const maxOutputChars = request.maxOutputChars ?? 2_000_000;

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
    let settled = false;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        stdout,
        stderr,
        aborted,
        timedOut,
        durationMs: Date.now() - startedAt
      });
    };
    const stop = () => {
      if (!child.killed) child.kill();
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, request.timeoutMs);

    request.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk, maxOutputChars);
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk, maxOutputChars);
    });
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
