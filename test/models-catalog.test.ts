import { afterEach, describe, expect, it, vi } from "vitest";
import {
  catalogModelsFor,
  fetchModelsCatalog,
  resolveCatalogProviderKey
} from "../src/agents/models-catalog.js";

// Seed the in-memory catalog directly (tests don't hit the network).
function seedCatalog() {
  const cat = {
    openai: { id: "openai", name: "OpenAI", models: { "gpt-4o": { id: "gpt-4o" }, "gpt-5": { id: "gpt-5" } } },
    anthropic: { id: "anthropic", name: "Anthropic", models: { "claude-sonnet-4-6": { id: "claude-sonnet-4-6" }, "claude-opus-4-6": { id: "claude-opus-4-6" } } },
    google: { id: "google", name: "Google", models: { "gemini-3.7-flash": { id: "gemini-3.7-flash" } } },
    "opencode-go": { id: "opencode-go", name: "OpenCode Go", api: "https://opencode.ai/zen/go/v1", models: { "deepseek-v4-flash": { id: "deepseek-v4-flash" }, "deepseek-v4-pro": { id: "deepseek-v4-pro" } } },
    deepseek: { id: "deepseek", name: "DeepSeek", models: { "deepseek-chat": { id: "deepseek-chat" } } }
  } as any;
  // Use the internal setter via a fresh fetch that returns the seed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__MODELS_CATALOG_SEED__ = cat;
  return cat;
}

afterEach(() => {
  vi.restoreAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__MODELS_CATALOG_SEED__;
  vi.resetModules();
});

describe("models-catalog", () => {
  it("maps maestropy provider ids to models.dev keys", async () => {
    seedCatalog();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => (globalThis as any).__MODELS_CATALOG_SEED__
    }));
    await fetchModelsCatalog();
    expect(resolveCatalogProviderKey("codex")).toBe("openai");
    expect(resolveCatalogProviderKey("claude")).toBe("anthropic");
    expect(resolveCatalogProviderKey("antigravity")).toBeNull();
    expect(resolveCatalogProviderKey("opencode-go")).toBe("opencode-go");
  });

  it("returns catalog models for a mapped provider", async () => {
    const cat = seedCatalog();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => cat
    }));
    await fetchModelsCatalog();
    expect(catalogModelsFor("codex")).toContain("gpt-4o");
    expect(catalogModelsFor("claude")).toContain("claude-sonnet-4-6");
    expect(catalogModelsFor("opencode-go")).toContain("deepseek-v4-pro");
    // antigravity is intentionally NOT sourced from models.dev (its CLI/account
    // lists its own gemini ids); the registry falls back to provider.models().
    expect(catalogModelsFor("antigravity")).toEqual([]);
  });

  it("falls back to null for unknown providers (registry uses provider.models())", async () => {
    const cat = seedCatalog();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => cat
    }));
    await fetchModelsCatalog();
    expect(resolveCatalogProviderKey("unknown-provider")).toBeNull();
  });

  it("tolerates a failed fetch and keeps an empty catalog", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const cat = await fetchModelsCatalog();
    expect(cat).toBeTruthy();
  });
});
