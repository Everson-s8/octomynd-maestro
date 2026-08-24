export type DashboardRequestOptions = {
  host?: string;
  port?: number;
  timeoutMs?: number;
};

export class DashboardRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null
  ) {
    super(message);
    this.name = "DashboardRequestError";
  }
}

export function dashboardUrl(pathname: string, options: DashboardRequestOptions = {}): string {
  const host = options.host?.trim() || process.env.MAESTRO_DASHBOARD_HOST?.trim() || "127.0.0.1";
  const port = options.port
    ?? parsePort(process.env.MAESTRO_DASHBOARD_PORT)
    ?? 4787;
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `http://${host}:${port}${path}`;
}

export async function requestDashboardJson<T>(
  pathname: string,
  init: RequestInit = {},
  options: DashboardRequestOptions = {}
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(dashboardUrl(pathname, options), {
      ...init,
      headers,
      signal: init.signal ?? controller.signal
    });
    const raw = await response.text();
    let payload: unknown = {};
    if (raw.trim()) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { details: raw };
      }
    }
    if (!response.ok) {
      throw new DashboardRequestError(apiErrorMessage(payload, response.status), response.status);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof DashboardRequestError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new DashboardRequestError("O dashboard nao respondeu dentro do tempo limite.");
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new DashboardRequestError(
      `Nao foi possivel conectar ao dashboard em ${dashboardUrl("/api/health", options)}: ${detail}. Inicie o Maestro antes (ex.: "maestro start" ou abrindo o app).`
    );
  } finally {
    clearTimeout(timeout);
  }
}

function parsePort(value: string | undefined): number | null {
  const port = Number.parseInt(value ?? "", 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function apiErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const body = payload as { details?: unknown; detail?: unknown; error?: unknown };
    const details = Array.isArray(body.details) ? body.details.join(" ") : body.details;
    const message = [details, body.detail, body.error].find(
      (item): item is string => typeof item === "string" && item.trim().length > 0
    );
    if (message) return message;
  }
  return `Dashboard respondeu com HTTP ${status}.`;
}
