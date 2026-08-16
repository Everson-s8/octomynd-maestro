import fs from "node:fs";
import path from "node:path";

/**
 * Models.dev catalog integration — the authoritative source of available model
 * ids per provider (mirrors how the Hermes agent resolves models).
 *
 * Fetches https://models.dev/api.json (a community database of 180+ providers
 * and thousands of models) and caches it on disk so repeated lookups don't hit
 * the network. When a provider has models in the catalog we use them as the
 * PRIMARY source; `provider.models()` (CLI discovery / curated lists) remains
 * the fallback for providers not present in the catalog.
 *
 * Resolution order (per provider): catalog -> provider.models() -> [].
 */

export type ModelsCatalog = {
  [providerId: string]: {
    id: string;
    name: string;
    api?: string;
    models?: Record<string, { id: string; name?: string }>;
  };
};

let _catalog: ModelsCatalog | null = null;
let _catalogTime = 0;
const CATALOG_TTL_MS = 3_600_000; // 1 hour
const CATALOG_URL = "https://models.dev/api.json";

function catalogDiskPath(): string {
  return path.join(process.cwd(), ".maestro", "models-dev-cache.json");
}

function loadCatalogFromDisk(): ModelsCatalog | null {
  try {
    const p = catalogDiskPath();
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return data && typeof data === "object" ? (data as ModelsCatalog) : null;
  } catch {
    return null;
  }
}

function saveCatalogToDisk(catalog: ModelsCatalog): void {
  try {
    const p = catalogDiskPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(catalog), "utf8");
  } catch {
    /* non-fatal */
  }
}

/** Fetch the catalog (cached in-process for 1h + disk cache). Never throws. */
export async function fetchModelsCatalog(): Promise<ModelsCatalog> {
  if (_catalog && Date.now() - _catalogTime < CATALOG_TTL_MS) return _catalog;
  const disk = loadCatalogFromDisk();
  if (disk && Date.now() - _catalogTime >= CATALOG_TTL_MS) {
    _catalog = disk;
    _catalogTime = Date.now();
    return disk;
  }
  if (disk) _catalog = disk;
  try {
    const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(5_000) });
    if (response.ok) {
      const data = (await response.json()) as ModelsCatalog;
      if (data && typeof data === "object") {
        _catalog = data;
        _catalogTime = Date.now();
        saveCatalogToDisk(data);
      }
    }
  } catch {
    /* network failure: keep whatever we have in memory/disk */
  }
  return _catalog ?? {};
}

/**
 /** Map a Maestro provider id / endpoint to a models.dev provider key. 
  * NOTE: antigravity/gemini are intentionally NOT mapped — the antigravity CLI
  * lists its own account model ids (gemini-3.7-flash, etc.) which differ from
  * models.dev's 'google' entry; keep its hardcoded/CLI discovery instead. */
 const PROVIDER_ID_TO_CATALOG: Record<string, string> = {
   codex: "openai",
   claude: "anthropic",
   deepseek: "deepseek",
   mistral: "mistral",
   openrouter: "openrouter"
 };

export function resolveCatalogProviderKey(providerId: string, endpointUrl?: string | null): string | null {
  const id = providerId.toLowerCase();
  if (!_catalog || !Object.keys(_catalog).length) return null;
  const shared = Object.keys(_catalog);

  // Explicit Maestro-provider -> models.dev mapping first.
  const mapped = PROVIDER_ID_TO_CATALOG[id];
  if (mapped && shared.includes(mapped)) return mapped;

  // opencode-go: prefer the opencode-go (opencode.ai/zen) entry which mirrors
  // the exact account lineup (deepseek-v4, gpt-5.6-luna, mimo, etc.).
  if (shared.includes("opencode-go") && (id.includes("opencode") || id === "deepseek-gopencode")) {
    return "opencode-go";
  }
  if (shared.includes("opencode") && id.includes("opencode")) return "opencode";

  // Match by endpoint host (OpenAI-compatible gateways).
  if (endpointUrl) {
    const host = endpointUrl.replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
    const byHost = shared.find((k) => {
      const api = _catalog?.[k]?.api ?? "";
      return api && api.includes(host);
    });
    if (byHost) return byHost;
  }

  // Generic fallback: exact, or substring that resolves.
  const exact = shared.find((k) => k.toLowerCase() === id);
  if (exact) return exact;
  return null;
}

/** Return the model ids for a provider from the catalog (primary source). */
export function catalogModelsFor(providerId: string, endpointUrl?: string | null): string[] {
  if (!_catalog) return [];
  const key = resolveCatalogProviderKey(providerId, endpointUrl);
  if (!key) return [];
  const provider = _catalog[key];
  if (!provider?.models) return [];
  const ids = Object.values(provider.models)
    .map((m) => m.id?.trim())
    .filter((id): id is string => Boolean(id));
  // Keep ids deduplicated and sorted for stable dropdowns.
  return [...new Set(ids)].sort();
}

/** Async variant: ensures the catalog is loaded before resolving. */
export async function availableModelsFor(
  providerId: string,
  endpointUrl?: string | null
): Promise<string[]> {
  await fetchModelsCatalog();
  const catalogModels = catalogModelsFor(providerId, endpointUrl);
  if (catalogModels.length > 0) return catalogModels;
  return [];
}

/** Best-effort warm the disk cache on startup without blocking. */
export function warmModelsCatalogCache(): void {
  void fetchModelsCatalog();
}
