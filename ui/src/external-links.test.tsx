import { afterEach, describe, expect, it, vi } from "vitest";
import { retryDesktopUpdate } from "./external-links";

describe("desktop update recovery bridge", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns false when the desktop retry action is unavailable", async () => {
    vi.stubGlobal("window", {});

    await expect(retryDesktopUpdate()).resolves.toBe(false);
  });

  it("invokes the desktop update check and reports whether it started", async () => {
    const retryUpdate = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("window", { maestroDesktop: { retryUpdate } });

    await expect(retryDesktopUpdate()).resolves.toBe(true);
    expect(retryUpdate).toHaveBeenCalledOnce();
  });
});
