// Builds the set of quota fetchers the Maestro exposes at GET /api/quota.
//
// Each fetcher reads the provider's OWN credential store on demand (never
// logs/persists tokens) and returns normalized buckets (used% / remaining% /
// resetsAt). Providers without usable credentials yield `unavailable` instead
// of throwing, so the dashboard degrades gracefully.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

// ---- Gemini / Antigravity -------------------------------------------------
// Reads ~/.gemini/oauth_creds.json (same creds the agy/Gemini CLI use) and hits
// the Code Assist retrieveUserQuota endpoint. Antigravity mirrors Gemini.
const GEMINI_RETRIEVE_QUOTA = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
// The OAuth client the Gemini CLI / antigravity uses to refresh tokens.
const GEMINI_OAUTH_CLIENT_ID = "884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

async function geminiToken(): Promise<string | null> {
  try {
    const creds = readJson(homeFile(".gemini", "oauth_creds.json")) as {
      access_token?: string;
      refresh_token?: string;
      expiry_date?: number;
    };
    if (!creds.access_token) return null;
    const now = Date.now();
    // If expired and we have a refresh token, try a lightweight refresh.
    if (creds.expiry_date && now > creds.expiry_date && creds.refresh_token) {
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.refresh_token,
        client_id: GEMINI_OAUTH_CLIENT_ID
      });
      try {
        const res = await fetch(GOOGLE_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form
        });
        if (res.ok) {
          const tok = (await res.json()) as { access_token?: string };
          if (tok.access_token) return tok.access_token;
        }
      } catch {
        // fall through to using the stored (possibly expired) token
      }
    }
    return creds.access_token;
  } catch {
    return null;
  }
}

async function geminiFetcher(): Promise<QuotaResult> {
  const token = await geminiToken();
  if (!token) return buildEmptyUnavailable("antigravity", "credenciais do Gemini não encontradas (~/.gemini/oauth_creds.json)");
  const project = (() => {
    try {
      const p = readJson(homeFile(".gemini", "projects.json")) as { projects?: Record<string, string> };
      const first = Object.values(p.projects ?? {})[0];
      return first ?? "";
    } catch {
      return "";
    }
  })();
  try {
    const res = await fetch(GEMINI_RETRIEVE_QUOTA, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ project })
    });
    if (!res.ok) return buildError("antigravity", new Error(`gemini retrieveUserQuota ${res.status}`));
    const data = (await res.json()) as { buckets?: { remainingFraction?: number; resetTime?: string; modelId?: string }[] };
    const buckets: QuotaBucket[] = (data.buckets ?? [])
      .filter((b) => typeof b.remainingFraction === "number")
      .map((b) => remainingFractionToBucket({
        provider: "antigravity",
        modelId: b.modelId ?? null,
        remainingFraction: b.remainingFraction ?? null,
        resetTime: b.resetTime ?? null,
        windowKind: "unknown",
        windowMinutes: null
      }));
    return {
      provider: "antigravity",
      status: buckets.length ? "ok" : "unavailable",
      updatedAt: new Date().toISOString(),
      buckets,
      error: buckets.length ? null : "gemini sem buckets de quota"
    };
  } catch (error) {
    return buildError("antigravity", error);
  }
}

// ---- Claude (OAuth subscription) -------------------------------------------
// Reads the OAuth access token from the Claude CLI config if present, else
// unavailable. Endpoint mirrors Orca's claude-fetcher.
const ANTHROPIC_OAUTH_USAGE = "https://api.anthropic.com/api/oauth/usage";

async function claudeToken(): Promise<string | null> {
  // Claude Code stores OAuth tokens in the config directory/service.
  const candidates = [
    process.env.CLAUDE_CODE_OAUTH_TOKEN,
    (() => { try { return (readJson(homeFile(".claude", "oauth_accounts.json")) as { active?: string })?.active; } catch { return null; } })(),
    (() => { try { return (readJson(homeFile(".claude", "credentials.json")) as { access_token?: string })?.access_token; } catch { return null; } })()
  ];
  return candidates.find((c) => typeof c === "string" && c.length > 0) ?? null;
}

async function claudeFetcher(): Promise<QuotaResult> {
  const token = await claudeToken();
  if (!token) return buildEmptyUnavailable("claude", "OAuth token do Claude não encontrado (subscription)");
  try {
    const res = await fetch(ANTHROPIC_OAUTH_USAGE, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2024-10-01", "User-Agent": "claude-code/2.1.0" }
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
          planType: null
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
    antigravity: geminiFetcher,
    claude: claudeFetcher
  };
}
