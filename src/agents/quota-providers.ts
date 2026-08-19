// Builds the set of quota fetchers the Maestro exposes at GET /api/quota.
//
// Each fetcher reads the provider's OWN credential store on demand (never
// logs/persists tokens) and returns normalized buckets (used% / remaining% /
// resetsAt). Providers without usable credentials yield `unavailable` instead
// of throwing, so the dashboard degrades gracefully.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import {
  QuotaBucket,
  QuotaFetcher,
  QuotaResult,
  buildEmptyUnavailable,
  buildError,
  remainingFractionToBucket,
  usedLimitToBucket,
} from "./quota-fetcher.js";

export { fetchAllQuota } from "./quota-fetcher.js";

// ---- helpers ---------------------------------------------------------------

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function homeFile(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

// ---- Codex (ChatGPT OAuth) -------------------------------------------------
// Reads ~/.codex/auth.json and hits the wham backend for rate-limit reset
// credits (5h / weekly windows). Mirrors Orca's codex-fetcher.
const CHATGPT_WHAM_USAGE = "https://chatgpt.com/backend-api/wham/usage";
const CHATGPT_WHAM_RATE_LIMIT_RESET = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

// Codex (ChatGPT) wham usage, mirrored from Orca: primary/secondary rate-limit
// windows each carry { used_percent, limit_window_seconds, reset_at } and
// plan_type is on the root object.
type CodexWindow = { used_percent?: number; limit_window_seconds?: number; reset_at?: number };
type CodexUsage = {
  plan_type?: string;
  rate_limit?: {
    primary_window?: CodexWindow;
    secondary_window?: CodexWindow;
  };
};

async function fetchWham(url: string, token: string, accountId: string | null): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "codex-cli",
    "OpenAI-Beta": "codex-1",
    originator: "Codex Desktop",
    "Content-Type": "application/json"
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`codex wham ${res.status}`);
  return res.json();
}

async function codexFetcher(): Promise<QuotaResult> {
  const authPath = homeFile(".codex", "auth.json");
  if (!fs.existsSync(authPath)) {
    return buildEmptyUnavailable("codex", "~/.codex/auth.json não encontrado");
  }
  const auth = readJson(authPath) as { tokens?: { access_token?: string; account_id?: string } };
  const token = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id ?? null;
  if (!token) return buildEmptyUnavailable("codex", "codex sem access_token");

  try {
    // Primary windows (used/limit for 5h & weekly) come from the usage endpoint.
    const data = (await fetchWham(CHATGPT_WHAM_USAGE, token, accountId)) as CodexUsage;
    const buckets: QuotaBucket[] = [];
    const planType = data.plan_type ?? null;
    if (data.rate_limit?.primary_window) {
      buckets.push(toWindowBucket("codex", data.rate_limit.primary_window, "primary", planType));
    }
    if (data.rate_limit?.secondary_window) {
      buckets.push(toWindowBucket("codex", data.rate_limit.secondary_window, "secondary", planType));
    }
    if (buckets.length === 0) {
      // Fallback: reset-credits (credits / available) if usage was empty.
      const reset = (await fetchWham(CHATGPT_WHAM_RATE_LIMIT_RESET, token, accountId)) as {
        credits?: number;
        available_count?: number;
      };
      if (typeof reset?.credits === "number" && typeof reset?.available_count === "number") {
        buckets.push({
          provider: "codex",
          modelId: null,
          usedPercent: Math.round(((reset.credits - reset.available_count) / Math.max(1, reset.credits)) * 100),
          remainingPercent: Math.round((reset.available_count / Math.max(1, reset.credits)) * 100),
          resetsAt: null,
          windowMinutes: null,
          windowKind: "weekly",
          planType
        });
      }
    }
    return {
      provider: "codex",
      status: buckets.length ? "ok" : "unavailable",
      updatedAt: new Date().toISOString(),
      buckets,
      error: buckets.length ? null : "sem dados de quota no wham"
    };
  } catch (error) {
    return buildError("codex", error);
  }
}

// Maps a wham window into a normalized bucket (300min = 5h session, else weekly).
function toWindowBucket(
  provider: string,
  win: CodexWindow,
  kind: "primary" | "secondary",
  planType: string | null
): QuotaBucket {
  const used = num(win.used_percent);
  const windowSeconds = num(win.limit_window_seconds);
  const isSession = windowSeconds != null && windowSeconds <= 3600; // ~5h
  return {
    provider,
    modelId: null,
    usedPercent: used == null ? null : Math.min(100, Math.max(0, Math.round(used))),
    remainingPercent: used == null ? null : Math.max(0, 100 - Math.min(100, Math.round(used))),
    resetsAt: num(win.reset_at) ? new Date(Math.round(num(win.reset_at)! * 1000)).toISOString() : null,
    windowMinutes: isSession ? 300 : 10080,
    windowKind: isSession ? "5h" : "weekly",
    planType
  };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// ---- Build ------------------------------------------------------------------

// ---- Antigravity (agy local language server) -------------------------------
// The gemini-cli OAuth flow that Orca used (retrieveUserQuota on
// cloudcode-pa.googleapis.com) was migrated to Antigravity, so the old path
// returns 401/IneligibleTier. The current mechanism (mirrors CodexBar): query
// the agy CLI's local HTTPS language server while agy is alive. It exposes
// RetrieveUserQuotaSummary with two pools (Gemini and Claude+GPT) each with a
// weekly and a 5-hour bucket.
const ANTIGRAVITY_SUMMARY_PATH =
  "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const ANTIGRAVITY_USER_STATUS_PATH =
  "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const ANTIGRAVITY_QUOTA_BODY = JSON.stringify({
  ideName: "antigravity",
  extensionName: "antigravity",
  locale: "en",
  ideVersion: "unknown"
});

// Finds a loopback port owned by a running agy (language server). Returns null
// when agy is not running.
function findAgyLoopbackPort(): number[] {
  try {
    const sbin = execFileSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true })
      .toString();
    const byPid = new Map<number, number[]>(); // pid -> loopback ports
    for (const line of sbin.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
      if (m) {
        const pid = Number(m[2]);
        if (!byPid.has(pid)) byPid.set(pid, []);
        byPid.get(pid)!.push(Number(m[1]));
      }
    }
    // Find the agy pid then its loopback ports.
    const task = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true })
      .toString();
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

// Fetches a language-server RPC over the agy local port. The agy exposes the
// language server over HTTPS (self-signed cert) on one loopback port and over
// plain HTTP on another, so try HTTPS then HTTP. Returns the decoded JSON.
async function postAgyRpc(port: number, servicePath: string): Promise<unknown> {
  const body = ANTIGRAVITY_QUOTA_BODY;
  const tryProtocol = (mod: typeof import("node:https") | typeof import("node:http"), tls: boolean) =>
    new Promise<unknown>((resolve) => {
      const req = (mod as any).request(
        {
          hostname: "127.0.0.1",
          port,
          path: servicePath,
          method: "POST",
          rejectUnauthorized: false,
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
        } as any,
        (res: any) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: any) => chunks.push(Buffer.from(c)));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const m = text.match(/\{"response":\s*\{/);
            if (!m || res.statusCode !== 200) {
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(text.slice(m.index!)));
            } catch {
              resolve(null);
            }
          });
        }
      );
      req.on("error", () => resolve(null));
      req.end(body);
    });

  const https = await import("node:https");
  const httpM = await import("node:http");
  const overHttps = await tryProtocol(https, true);
  if (overHttps) return overHttps;
  return tryProtocol(httpM, false);
}

type AntigravityBucket = {
  bucketId?: string;
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
  displayName?: string;
};
type AntigravityGroup = { displayName?: string; buckets?: AntigravityBucket[] };

async function antigravityFetcher(): Promise<QuotaResult> {
  let ports = findAgyLoopbackPort();
  // If agy is not running, try to launch it briefly so its language server is up.
  if (ports.length === 0) {
    const spawned = spawn("agy", [], { stdio: "ignore", detached: true });
    spawned.unref();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      ports = findAgyLoopbackPort();
      if (ports.length) break;
    }
  }
  if (ports.length === 0) {
    return buildEmptyUnavailable("antigravity", "agy não está rodando (sem sessão Antigravity)");
  }

  // Try each loopback port; the agy exposes the language server over HTTPS on
  // one port and plain HTTP on another, so attempt both per port.
  let data: unknown = null;
  for (const p of ports) {
    data = await postAgyRpc(p, ANTIGRAVITY_SUMMARY_PATH);
    if (data && Array.isArray((data as any)?.response?.groups)) break;
  }
  const groups: AntigravityGroup[] = Array.isArray((data as any)?.response?.groups)
    ? (data as any).response.groups
    : [];
  if (groups.length === 0) return buildError("antigravity", new Error("RetrieveUserQuotaSummary sem groups"));

  const buckets: QuotaBucket[] = [];
  for (const g of groups) {
    const label = g.displayName ?? "Antigravity";
    const pool = /claude|gpt/i.test(label) ? "claude_gpt" : "gemini";
    for (const b of g.buckets ?? []) {
      const remFrac = typeof b.remainingFraction === "number" ? b.remainingFraction : null;
      const isWeekly = /weekly/i.test(b.window ?? b.bucketId ?? "");
      buckets.push({
        provider: "antigravity",
        modelId: `${pool}${isWeekly ? "-weekly" : "-5h"}`,
        usedPercent: remFrac == null ? null : Math.round((1 - remFrac) * 100),
        remainingPercent: remFrac == null ? null : Math.round(remFrac * 100),
        resetsAt: b.resetTime ?? null,
        windowMinutes: isWeekly ? 10080 : 300,
        windowKind: isWeekly ? "weekly" : "5h",
        planType: "pro",
        detail: label
      });
    }
  }
  return {
    provider: "antigravity",
    status: buckets.length ? "ok" : "unavailable",
    updatedAt: new Date().toISOString(),
    buckets,
    error: buckets.length ? null : "sem buckets de quota do antigravity"
  };
}

// ---- Claude (OAuth subscription) -------------------------------------------
// Reads the OAuth access token from the Claude CLI config if present, else
// unavailable. Endpoint mirrors Orca's claude-fetcher.
const ANTHROPIC_OAUTH_USAGE = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// Reads the Claude Code OAuth credentials from ~/.claude/.credentials.json
// (claudeAiOauth block) and refreshes the access token when it is expired.
async function claudeCredentials(): Promise<{
  token: string | null;
  planType: string | null;
  refreshToken: string | null;
} | null> {
  const credsPath = homeFile(".claude", ".credentials.json");
  if (!fs.existsSync(credsPath)) return null;
  try {
    const data = readJson(credsPath) as {
      claudeAiOauth?: {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
        subscriptionType?: string;
      };
    };
    const oauth = data.claudeAiOauth;
    if (!oauth) return null;
    const planType = oauth.subscriptionType ?? null;
    let token = oauth.accessToken ?? null;
    const expiresAt = oauth.expiresAt ?? 0;
    const refreshToken = oauth.refreshToken ?? null;
    // If expired and we have a refresh token, try to rotate at the Claude token endpoint.
    if (refreshToken && (!expiresAt || Date.now() > expiresAt)) {
      try {
        const form = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLAUDE_OAUTH_CLIENT_ID
        });
        const res = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form
        });
        if (res.ok) {
          const tok = (await res.json()) as { access_token?: string };
          if (tok.access_token) token = tok.access_token;
        }
      } catch {
        // keep the stored token
      }
    }
    return { token, planType, refreshToken };
  } catch {
    return null;
  }
}

async function claudeFetcher(): Promise<QuotaResult> {
  const creds = await claudeCredentials();
  const token = creds?.token ?? null;
  if (!token) return buildEmptyUnavailable("claude", "OAuth token do Claude não encontrado (subscription)");
  const planType = creds?.planType ?? null;
  try {
    const res = await fetch(ANTHROPIC_OAUTH_USAGE, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" }
    });
    if (!res.ok) return buildError("claude", new Error(`anthropic oauth usage ${res.status}`));
    const data = (await res.json()) as {
      five_hour?: { used_percentage?: number; utilization?: number; resets_at?: string | number };
      seven_day?: { used_percentage?: number; utilization?: number; resets_at?: string | number };
    };
    const buckets: QuotaBucket[] = [data.five_hour, data.seven_day]
      .filter(Boolean)
      .map((w, i) => {
        const raw = w as { used_percentage?: number; utilization?: number; resets_at?: string | number };
        const usedPct = typeof raw.utilization === "number" ? raw.utilization : typeof raw.used_percentage === "number" ? raw.used_percentage : null;
        const mins = i === 0 ? 300 : 10080;
        return {
          provider: "claude",
          modelId: null,
          usedPercent: usedPct == null ? null : Math.min(100, Math.max(0, Math.round(usedPct))),
          remainingPercent: usedPct == null ? null : Math.max(0, 100 - Math.min(100, Math.round(usedPct))),
          resetsAt: raw.resets_at == null ? null : new Date(resolveEpochMs(raw.resets_at)).toISOString(),
          windowMinutes: mins,
          windowKind: i === 0 ? "5h" : "weekly",
          planType
        };
      });
    return {
      provider: "claude",
      status: buckets.some((b) => b.usedPercent != null) ? "ok" : "unavailable",
      updatedAt: new Date().toISOString(),
      buckets,
      error: buckets.some((b) => b.usedPercent != null) ? null : "sem dados de uso OAuth"
    };
  } catch (error) {
    return buildError("claude", error);
  }
}

function resolveEpochMs(v: string | number): number {
  const num = typeof v === "number" ? v : Number(v);
  if (Number.isFinite(num)) return num > 10_000_000_000 ? num : num * 1000;
  const parsed = new Date(String(v)).getTime();
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

export function buildQuotaFetchers(): Record<string, QuotaFetcher> {
  return {
    codex: codexFetcher,
    antigravity: antigravityFetcher,
    claude: claudeFetcher
  };
}
