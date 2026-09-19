import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyLocaleMetadata, formatNumber, getLocale, getLocaleLabel, getRecommendedLocale, isLocale, SUPPORTED_LOCALES, translate, translateCount } from "./i18n";

function makeStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear() };
}

describe("interface locale behavior", () => {
  const storage = makeStorage();
  const documentElement = { lang: "", dir: "" };
  beforeEach(() => { storage.clear(); vi.stubGlobal("window", { localStorage: storage }); vi.stubGlobal("document", { documentElement }); vi.stubGlobal("navigator", { language: "en-US" }); });
  afterEach(() => vi.unstubAllGlobals());
  it("defines an extensible English-first locale registry", () => { expect(SUPPORTED_LOCALES.map((locale) => locale.id)).toEqual(["en", "pt-BR"]); expect(isLocale("en")).toBe(true); expect(isLocale("pt-BR")).toBe(true); expect(isLocale("fr")).toBe(false); expect(getLocaleLabel("pt-BR")).toBe("Brazilian Portuguese"); });
  it("persists only supported locale choices and defaults to English", () => { expect(getLocale()).toBe("en"); storage.setItem("maestro:locale", "pt-BR"); expect(getLocale()).toBe("pt-BR"); storage.setItem("maestro:locale", "fr"); expect(getLocale()).toBe("en"); });
  it("updates HTML language metadata for initial and switched locales", () => { applyLocaleMetadata("en"); expect(documentElement).toEqual({ lang: "en", dir: "ltr" }); applyLocaleMetadata("pt-BR"); expect(documentElement).toEqual({ lang: "pt-BR", dir: "ltr" }); });
  it("uses browser language only as a recommendation", () => { vi.stubGlobal("navigator", { language: "pt-BR" }); expect(getRecommendedLocale()).toBe("pt-BR"); vi.stubGlobal("navigator", { language: "en-US" }); expect(getRecommendedLocale()).toBe("en"); expect(getLocale()).toBe("en"); });
  it("falls back to canonical English copy when a Portuguese key is missing", () => { storage.setItem("maestro:locale", "pt-BR"); expect(translate("Settings")).toBe("Configurações"); expect(translate("A future untranslated key")).toBe("A future untranslated key"); expect(translateCount(1, "1 provider ready to use", "{count} providers ready to use")).toBe("1 provider pronto para uso"); expect(translateCount(2, "1 provider ready to use", "{count} providers ready to use")).toBe("2 providers prontos para uso"); expect(formatNumber(1234567)).toBe("1.234.567"); });
});
