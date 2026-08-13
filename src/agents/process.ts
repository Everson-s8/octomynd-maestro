import { spawn } from "node:child_process";

import type { AgentProviderId } from "./types.js";

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
  provider?: AgentProviderId;
  stdin?: string;
  timeoutMs?: number;
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
  spawnErrorCode?: string | null;
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
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
};

export async function runAgentProcess(request: AgentProcessRequest): Promise<AgentProcessResult> {
  const startedAt = Date.now();
  const maxOutputChars = request.maxOutputChars ?? 500_000;
  const maxReceivedChars = request.maxReceivedChars ?? Math.max(maxOutputChars * 4, maxOutputChars);
  const maxDuplicateChunks = request.maxDuplicateChunks ?? 80;
  const inactivityTimeoutMs = request.inactivityTimeoutMs
    ?? (request.timeoutMs === undefined ? 10 * 60_000 : Math.min(request.timeoutMs, 2 * 60_000));

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
    let spawnErrorCode: string | null = null;
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
      const tokenUsage = parseTokenUsageFromOutput(stdout, stderr, request.provider);
      resolve({
        exitCode,
        spawnErrorCode,
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
        durationMs: Date.now() - startedAt,
        tokenUsage
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
    if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
      phaseTimer = setTimeout(() => tripBreaker("phase_timeout"), request.timeoutMs);
    }
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
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnErrorCode = error.code ?? null;
      stderr = appendBounded(stderr, `\n${error.message}`, maxOutputChars).trim();
      finish(null);
    });
    child.on("close", finish);

    if (request.stdin !== undefined) child.stdin?.end(request.stdin);
    if (request.signal?.aborted) onAbort();
  });
}

const ALLOWED_PROVIDER_ENV_KEYS = new Set([
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY"
]);

export function buildRestrictedAgentEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options?: { allowProviderKeys?: boolean; extraAllowedKeys?: string[] }
): NodeJS.ProcessEnv {
  const extraAllowed = options?.extraAllowedKeys
    ? new Set(options.extraAllowedKeys.map((k) => k.toUpperCase()))
    : undefined;
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !isSensitiveEnvironmentKey(key, options?.allowProviderKeys ?? false, extraAllowed)
    )
  );
}

function isSensitiveEnvironmentKey(
  key: string,
  allowProviderKeys: boolean,
  extraAllowed?: Set<string>
): boolean {
  const upperKey = key.toUpperCase();
  const secretShaped = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|API_KEY|PRIVATE_KEY|_?KEY)(?:_|$)/i.test(key);

  // allowProviderKeys opts the known provider-key names through.
  if (allowProviderKeys && ALLOWED_PROVIDER_ENV_KEYS.has(upperKey)) {
    return false;
  }

  // extraAllowedKeys is an EXPLICIT, provider-scoped allow-list: the custom
  // provider's config.environment author (operator) deliberately named the
  // keys a given provider may receive (e.g. envKeys: ["OPENCODE_API_KEY"]).
  // That explicit intent is authoritative — forwarding a provider's own auth
  // key to its spawned CLI is the whole point of envKeys. Without this, a
  // custom provider could never authenticate to the model it wraps.
  //
  // This is NOT a global bypass: it only affects the keys an operator
  // explicitly opt-in per provider, and the restricted env build is invoked
  // per provider, so operators can only forward keys scoped to that config.
  if (extraAllowed?.has(upperKey)) {
    return false;
  }

  return secretShaped;
}

function appendBounded(current: string, chunk: string, maxChars: number): string {
  const next = current + chunk;
  return next.length <= maxChars ? next : next.slice(-maxChars);
}

export function parseTokenUsageFromOutput(
  stdout: string,
  stderr: string,
  provider?: AgentProviderId
): { inputTokens: number; outputTokens: number } {
  try {
    const combined = `${stdout}\n${stderr}`;

    // 1. Try parsing JSON objects with balanced braces
    const jsonObjects = findJsonObjects(combined);
    for (const parsed of jsonObjects) {
      const usageObj = (parsed.usage && typeof parsed.usage === "object") ? parsed.usage as Record<string, unknown> : parsed;
      const input = extractNumber(usageObj, [
        "input_tokens", "inputTokens", "prompt_tokens", "promptTokens",
        "prompt_eval_count", "input_tokens_used"
      ]);
      const output = extractNumber(usageObj, [
        "output_tokens", "outputTokens", "completion_tokens", "completionTokens",
        "eval_count", "output_tokens_used"
      ]);
      if (input !== null || output !== null) {
        return {
          inputTokens: Math.max(0, input ?? 0),
          outputTokens: Math.max(0, output ?? 0)
        };
      }
    }

    // 2. Try Regex patterns for CLI outputs
    const p1 = /(\d[\d,]*)\s*input[s]?[\s,]+(\d[\d,]*)\s*output[s]?/i.exec(combined);
    if (p1) {
      return { inputTokens: parseNum(p1[1]), outputTokens: parseNum(p1[2]) };
    }

    const p2 = /(\d[\d,]*)\s*in\s*[\/\,]\s*(\d[\d,]*)\s*out/i.exec(combined);
    if (p2) {
      return { inputTokens: parseNum(p2[1]), outputTokens: parseNum(p2[2]) };
    }

    const p3 = /prompt\s*tokens?:\s*(\d[\d,]*)[,\s]+completion\s*tokens?:\s*(\d[\d,]*)/i.exec(combined);
    if (p3) {
      return { inputTokens: parseNum(p3[1]), outputTokens: parseNum(p3[2]) };
    }

    const p4 = /input\s*tokens?:\s*(\d[\d,]*)[,\s]+output\s*tokens?:\s*(\d[\d,]*)/i.exec(combined);
    if (p4) {
      return { inputTokens: parseNum(p4[1]), outputTokens: parseNum(p4[2]) };
    }

    const p5 = /(\d[\d,]*)\s*prompt[s]?[,\s]+(\d[\d,]*)\s*completion/i.exec(combined);
    if (p5) {
      return { inputTokens: parseNum(p5[1]), outputTokens: parseNum(p5[2]) };
    }

    let inputTokens = 0;
    let outputTokens = 0;

    const inMatch = /(?:input_tokens|input\s*tokens?|prompt_tokens|prompt\s*tokens?|prompt|in):\s*(\d[\d,]*)/i.exec(combined)
      || /(\d[\d,]*)\s*(?:input|prompt)\s*tokens?/i.exec(combined);
    if (inMatch) inputTokens = parseNum(inMatch[1]);

    const outMatch = /(?:output_tokens|output\s*tokens?|completion_tokens|completion\s*tokens?|completion|out):\s*(\d[\d,]*)/i.exec(combined)
      || /(\d[\d,]*)\s*(?:output|completion)\s*tokens?/i.exec(combined);
    if (outMatch) outputTokens = parseNum(outMatch[1]);

    return { inputTokens, outputTokens };
  } catch {
    return { inputTokens: 0, outputTokens: 0 };
  }
}

function findJsonObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (char === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          const candidate = text.slice(start, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              objects.push(parsed as Record<string, unknown>);
            }
          } catch {
            // ignore invalid JSON candidate
          }
          start = -1;
        }
      }
    }
  }
  return objects;
}

function extractNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    if (k in obj) {
      const val = obj[k];
      if (typeof val === "number") return val;
      if (typeof val === "string") {
        const num = Number(val.replace(/,/g, ""));
        if (!isNaN(num)) return num;
      }
    }
  }
  return null;
}

function parseNum(str: string): number {
  const num = parseInt(str.replace(/,/g, ""), 10);
  return isNaN(num) ? 0 : num;
}
