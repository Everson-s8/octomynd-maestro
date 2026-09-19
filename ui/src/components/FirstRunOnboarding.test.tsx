import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ONBOARDING_COMPLETED_KEY, ONBOARDING_STEP_KEY, readOnboardingState, resetOnboarding } from "./FirstRunOnboarding";

function makeStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear() };
}

describe("first-run onboarding persistence", () => {
  const storage = makeStorage();
  beforeEach(() => { storage.clear(); vi.stubGlobal("window", { localStorage: storage }); });
  afterEach(() => vi.unstubAllGlobals());
  it("starts at language and safely ignores invalid persisted steps", () => { expect(readOnboardingState()).toEqual({ step: "language", completed: false }); storage.setItem(ONBOARDING_STEP_KEY, "not-a-step"); storage.setItem(ONBOARDING_COMPLETED_KEY, "true"); expect(readOnboardingState()).toEqual({ step: "language", completed: true }); });
  it("resets both completion and progress for a repeatable setup", () => { storage.setItem(ONBOARDING_STEP_KEY, "first-action"); storage.setItem(ONBOARDING_COMPLETED_KEY, "true"); resetOnboarding(); expect(readOnboardingState()).toEqual({ step: "language", completed: false }); });
});
