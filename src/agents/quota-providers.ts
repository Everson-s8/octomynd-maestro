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
  QuotaUnavailableReason,
  buildEmptyUnavailable,
  buildError,
  remainingFractionToBucket,
  usedLimitToBucket,
} from "./quota-fetcher.js";
import { resolveAntigravityExecutable } from "./antigravity.js";
import { resolveCustomCliExecutable } from "./custom-cli.js";
import {
  ensureAntigravitySession,
  findAgyLoopbackPort,
  stopAntigravitySession,
  touchAntigravitySession
} from "./antigravity-session.js";

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
  const isSession = windowSeconds != null && windowSeconds <= 18000; // ~5h (5*3600s)
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
const ANTIGRAVITY_QUOTA_BUDGET_MS = 14_000;
const ANTIGRAVITY_USER_STATUS_PATH =
  "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const ANTIGRAVITY_QUOTA_BODY = JSON.stringify({
  ideName: "antigravity",
  extensionName: "antigravity",
  locale: "en",
  ideVersion: "unknown"
});

// Fetches a language-server RPC over the agy local port. The agy exposes the
// language server over HTTPS (self-signed cert) on one loopback port and over
// plain HTTP on another, so try HTTPS then HTTP. Returns the decoded JSON.
async function postAgyRpc(port: number, servicePath: string, deadlineAt: number): Promise<unknown> {
  const body = ANTIGRAVITY_QUOTA_BODY;
  const tryProtocol = (mod: typeof import("node:https") | typeof import("node:http")) =>
    new Promise<unknown>((resolve) => {
      const remainingMs = Math.min(1_500, deadlineAt - Date.now());
      if (remainingMs <= 0) {
        resolve(null);
        return;
      }
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
      req.setTimeout(remainingMs, () => {
        req.destroy();
        resolve(null);
      });
      req.end(body);
    });

  const https = await import("node:https");
  const httpM = await import("node:http");
  const overHttps = await tryProtocol(https);
  if (overHttps) return overHttps;
  return tryProtocol(httpM);
}

type AntigravityBucket = {
  bucketId?: string;
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
  displayName?: string;
};
type AntigravityGroup = { displayName?: string; buckets?: AntigravityBucket[] };

async function antigravityFetcher(deadlineAt: number): Promise<QuotaResult> {
  const ports = findAgyLoopbackPort();
  if (ports.length === 0) {
    return buildEmptyUnavailable("antigravity", "agy não está rodando (sem sessão Antigravity)");
  }

  // Try each loopback port; the agy exposes the language server over HTTPS on
  // one port and plain HTTP on another, so attempt both per port.
  let data: unknown = null;
  // The CLI can report an empty groups list for a few seconds while its
  // background quota refresh completes. Stay inside the bounded request
  // timeout and retry that initialization window instead of exposing a false
  // provider error to the first dashboard render.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (Date.now() >= deadlineAt) break;
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(1, deadlineAt - Date.now()))));
    }
    for (const p of ports) {
      if (Date.now() >= deadlineAt) break;
      data = await postAgyRpc(p, ANTIGRAVITY_SUMMARY_PATH, deadlineAt);
      const groups = (data as any)?.response?.groups;
      if (Array.isArray(groups) && groups.length > 0) break;
    }
    const groups = (data as any)?.response?.groups;
    if (Array.isArray(groups) && groups.length > 0) break;
  }
  const groups: AntigravityGroup[] = Array.isArray((data as any)?.response?.groups)
    ? (data as any).response.groups
    : [];
  if (groups.length === 0) {
    return buildError("antigravity", new Error("RetrieveUserQuotaSummary sem groups"), "no_data");
  }

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
        planType: null,
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

async function antigravityQuotaFetcher(): Promise<QuotaResult> {
  // An uninstalled CLI can never produce a quota reading: report the truth
  // ("not installed") instead of registering a fetcher that always fails.
  if (!resolveAntigravityExecutable()) {
    return buildEmptyUnavailable("antigravity", "CLI 'agy' não está instalada", "not_installed");
  }
  // Authentication alone does not create the local language-server session.
  // Start one resumable, prompt-less CLI session on demand for the dashboard.
  // It is singleton-managed and automatically stopped after idle timeout.
  const deadlineAt = Date.now() + ANTIGRAVITY_QUOTA_BUDGET_MS;
  if (!(await ensureAntigravitySession(deadlineAt))) {
    return buildEmptyUnavailable(
      "antigravity",
      "CLI Antigravity autenticada, mas o Maestro não conseguiu manter a sessão local do agy ativa; tente abrir o Antigravity CLI uma vez e atualize a leitura",
      "session_down"
    );
  }
  const result = await antigravityFetcher(deadlineAt);
  touchAntigravitySession();
  return result;
}

export { stopAntigravitySession };

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
    const windows: Array<{ kind: "5h" | "weekly"; raw?: { used_percentage?: number; utilization?: number; resets_at?: string | number } }> = [
      { kind: "5h", raw: data.five_hour },
      { kind: "weekly", raw: data.seven_day }
    ];
    const buckets: QuotaBucket[] = [];
    for (const w of windows) {
      if (!w.raw) continue;
      const usedPct =
        typeof w.raw.utilization === "number"
          ? w.raw.utilization
          : typeof w.raw.used_percentage === "number"
            ? w.raw.used_percentage
            : null;
      const mins = w.kind === "5h" ? 300 : 10080;
      buckets.push({
        provider: "claude",
        modelId: w.kind === "5h" ? "claude-5h" : "claude-weekly",
        usedPercent: usedPct == null ? null : Math.min(100, Math.max(0, Math.round(usedPct))),
        remainingPercent: usedPct == null ? null : Math.max(0, 100 - Math.min(100, Math.round(usedPct))),
        resetsAt: w.raw.resets_at == null ? null : new Date(resolveEpochMs(w.raw.resets_at)).toISOString(),
        windowMinutes: mins,
        windowKind: w.kind,
        planType
      });
    }
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

// ---- OpenRouter ------------------------------------------------------------
// Uses an OpenRouter API key to read quota/usage. Requires OPENROUTER_API_KEY.
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";

async function openRouterFetcher(): Promise<QuotaResult> {
  const key = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY ?? null;
  if (!key) return buildEmptyUnavailable("openrouter", "sem OPENROUTER_API_KEY");
  try {
    const res = await fetch(OPENROUTER_KEY_URL, {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!res.ok) return buildError("openrouter", new Error(`openrouter key ${res.status}`));
    const data = (await res.json()) as {
      data?: { limit?: number | null; usage?: number; is_free_tier?: boolean; usage_limit?: number | null };
    };
    const usg = data.data;
    if (!usg || typeof usg.usage !== "number") return buildEmptyUnavailable("openrouter", "sem uso de quota");
    const limit = typeof usg.limit === "number" && usg.limit > 0 ? usg.limit : null;
    const bucket = usedLimitToBucket({
      provider: "openrouter",
      modelId: null,
      used: usg.usage,
      limit,
      resetsAt: null,
      windowKind: "unknown",
      windowMinutes: null,
      planType: usg.is_free_tier ? "free" : null
    });
    return { provider: "openrouter", status: "ok", updatedAt: new Date().toISOString(), buckets: [bucket], error: null };
  } catch (error) {
    return buildError("openrouter", error);
  }
}

// ---- OpenAI (API key) ------------------------------------------------------
// Reads an OpenAI API key and reports usage against the monthly billed limit.
const OPENAI_USAGE_URL = "https://api.openai.com/v1/organization/usage/completions";

async function openAIFetcher(): Promise<QuotaResult> {
  const key = process.env.OPENAI_API_KEY ?? null;
  if (!key) return buildEmptyUnavailable("openai", "sem OPENAI_API_KEY");
  try {
    const res = await fetch(`${OPENAI_USAGE_URL}?start_time=${Math.floor(Date.now() / 1000) - 30 * 86400}`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!res.ok) return buildError("openai", new Error(`openai usage ${res.status}`));
    // Best-effort: OpenAI usage endpoint requires admin; if it fails, report based on data.
    const data = (await res.json()) as { data?: { total_usage?: number }[] };
    const used = data?.data?.[0]?.total_usage ?? null;
    if (used == null) return buildEmptyUnavailable("openai", "sem dados de uso (requer org admin)");
    const bucket = usedLimitToBucket({
      provider: "openai",
      modelId: null,
      used: used / 100, // OpenAI returns usage in cents
      limit: null,
      resetsAt: null,
      windowKind: "unknown",
      windowMinutes: null
    });
    return { provider: "openai", status: "ok", updatedAt: new Date().toISOString(), buckets: [bucket], error: null };
  } catch (error) {
    return buildError("openai", error);
  }
}

// ---- Gemini API (API key) --------------------------------------------------
const GEMINI_API_KEYED_MODELS =
  "https://generativelanguage.googleapis.com/v1beta/models";

async function geminiApiFetcher(): Promise<QuotaResult> {
  const key = process.env.GEMINI_API_KEY ?? null;
  if (!key) return buildEmptyUnavailable("gemini-api", "sem GEMINI_API_KEY");
  // The Gemini Developer API key lists models with per-model limits; here we only
  // prove connectivity rather than a real quota fraction, so mark unavailable.
  try {
    const res = await fetch(GEMINI_API_KEYED_MODELS, {
      headers: { "x-goog-api-key": key }
    });
    if (!res.ok) return buildError("gemini-api", new Error(`gemini models ${res.status}`));
    return buildEmptyUnavailable(
      "gemini-api",
      "API key válida; a API Gemini não expõe uma fração de cota utilizável neste endpoint"
    );
  } catch (error) {
    return buildError("gemini-api", error);
  }
}

// ---- OpenCode Go (API key) -------------------------------------------------
// Uses OPENCODE_GO_API_KEY against the opencode.ai OpenAI-compatible endpoint,
// whose /usage sub-resource reports rolling/weekly/monthly usage percentages.
const OPENCODE_GO_BASE = "https://opencode.ai/zen/go/v1";

async function openCodeGoFetcher(): Promise<QuotaResult> {
  const key = process.env.OPENCODE_GO_API_KEY ?? null;
  if (!key) return buildEmptyUnavailable("opencode-go", "sem OPENCODE_GO_API_KEY");
  try {
    const res = await fetch(`${OPENCODE_GO_BASE}/usage`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!res.ok) return buildError("opencode-go", new Error(`opencode usage ${res.status}`));
    const data = (await res.json()) as {
      usage?: {
        rolling?: { status?: string; percent?: number; resetsAt?: string };
        weekly?: { status?: string; percent?: number; resetsAt?: string };
        monthly?: { status?: string; percent?: number; resetsAt?: string };
      };
    };
    const u = data.usage;
    if (!u) return buildEmptyUnavailable("opencode-go", "sem dados de uso");
    const windows: Array<{ key: string; w: { percent?: number; resetsAt?: string } }> = [
      { key: "rolling", w: u.rolling ?? {} },
      { key: "weekly", w: u.weekly ?? {} },
      { key: "monthly", w: u.monthly ?? {} }
    ];
    const buckets: QuotaBucket[] = [];
    for (const { key, w } of windows) {
      const usedPct = typeof w.percent === "number" ? Math.max(0, Math.min(100, w.percent)) : null;
      if (usedPct == null) continue;
      buckets.push({
        provider: "opencode-go",
        modelId: `opencode-${key}`,
        usedPercent: usedPct,
        remainingPercent: Math.max(0, 100 - usedPct),
        resetsAt: w.resetsAt ?? null,
        windowMinutes: key === "rolling" ? null : key === "weekly" ? 10080 : 43200,
        windowKind: key === "monthly" ? "weekly" : key === "weekly" ? "weekly" : "5h",
        planType: null
      });
    }
    return {
      provider: "opencode-go",
      status: buckets.length ? "ok" : "unavailable",
      updatedAt: new Date().toISOString(),
      buckets,
      error: buckets.length ? null : "sem janelas de uso"
    };
  } catch (error) {
    return buildError("opencode-go", error);
  }
}

// Detects whether a provider is LOGGED IN / connected, so we only fetch quota
// for providers the user actually has. Returns a map of fetchers keyed by id.
export function buildQuotaFetchers(options: { providerIds?: ReadonlySet<string> } = {}): Record<string, QuotaFetcher> {
  const fetchers: Record<string, QuotaFetcher> = {};
  const allowed = (providerId: string): boolean => !options.providerIds || options.providerIds.has(providerId);

  // Codex: ~/.codex/auth.json present and has tokens. When the CLI is
  // installed but credentials are missing/empty, surface an explicit
  // "not_authenticated" row instead of silently omitting the provider.
  const codexAuthPath = homeFile(".codex", "auth.json");
  if (allowed("codex") && fs.existsSync(codexAuthPath)) {
    try {
      const auth = readJson(codexAuthPath) as { tokens?: { access_token?: string } };
      if (auth.tokens?.access_token) fetchers.codex = codexFetcher;
    } catch {
      /* skip */
    }
  }
  if (allowed("codex") && !fetchers.codex && resolveCustomCliExecutable("codex")) {
    fetchers.codex = async () =>
      buildEmptyUnavailable("codex", "Codex instalado, mas sem login concluído (~/.codex/auth.json ausente ou vazio)", "not_authenticated");
  }

  // Antigravity only when the CLI binary exists; otherwise the dashboard must
  // not show it as a connected provider with quota (it is just a catalog entry).
  if (allowed("antigravity") && resolveAntigravityExecutable()) {
    fetchers.antigravity = antigravityQuotaFetcher;
  }

  // Claude: ~/.claude/.credentials.json has claudeAiOauth.
  if (allowed("claude") && hasClaudeOAuthToken()) {
    fetchers.claude = claudeFetcher;
  }

  // OpenRouter / OpenAI / Gemini API: by env API key presence.
  if (allowed("openrouter") && (process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY)) fetchers.openrouter = openRouterFetcher;
  if (allowed("openai") && process.env.OPENAI_API_KEY) fetchers.openai = openAIFetcher;
  if (allowed("gemini-api") && process.env.GEMINI_API_KEY) fetchers["gemini-api"] = geminiApiFetcher;

  // OpenCode Go: by OPENCODE_GO_API_KEY env.
  if (allowed("opencode-go") && process.env.OPENCODE_GO_API_KEY) fetchers["opencode-go"] = openCodeGoFetcher;

  return fetchers;
}

function hasClaudeOAuthToken(): boolean {
  try {
    const data = readJson(homeFile(".claude", ".credentials.json")) as {
      claudeAiOauth?: { accessToken?: string };
    };
    return Boolean(data.claudeAiOauth?.accessToken?.trim());
  } catch {
    return false;
  }
}
