import { describe, expect, it } from "vitest";
import { isOpenableExternalUrl } from "../ui/src/external-links.js";

describe("external review links", () => {
  it("only accepts browser URLs and rejects local delivery placeholders", () => {
    expect(isOpenableExternalUrl("https://github.com/Everson-s8/octomynd-maestro/pull/132")).toBe(true);
    expect(isOpenableExternalUrl("http://127.0.0.1:4787/")).toBe(true);
    expect(isOpenableExternalUrl("local://maestro/task-4")).toBe(false);
    expect(isOpenableExternalUrl("javascript:alert(1)")).toBe(false);
  });
});
