import { describe, expect, it } from "vitest";
import { findAgyLoopbackPort, stopAntigravitySession } from "../src/agents/antigravity-session.js";

describe("Antigravity quota session manager", () => {
  it("returns a bounded list of numeric loopback ports", () => {
    const startedAt = Date.now();
    const ports = findAgyLoopbackPort();

    expect(ports.every((port) => Number.isInteger(port) && port > 0 && port <= 65_535)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it("can be stopped repeatedly without throwing", () => {
    expect(() => {
      stopAntigravitySession();
      stopAntigravitySession();
    }).not.toThrow();
  });
});
