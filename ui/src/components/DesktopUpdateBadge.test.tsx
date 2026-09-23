import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DesktopUpdateBadge } from "./DesktopUpdateBadge";

describe("desktop update badge", () => {
  const render = (status: Parameters<typeof DesktopUpdateBadge>[0]["status"]) =>
    renderToStaticMarkup(<DesktopUpdateBadge version="0.3.9" status={status} onInstall={vi.fn()} />);

  it("always identifies the installed version", () => {
    expect(render(null)).toContain("Maestro v0.3.9");
  });

  it("shows when the update check is running", () => {
    expect(render({ event: "checking" })).toContain("Checking for updates");
  });

  it("confirms when the client is current", () => {
    expect(render({ event: "up_to_date" })).toContain("You&#x27;re up to date.");
  });

  it("shows download version and progress", () => {
    expect(render({ event: "progress", version: "0.4.0", percent: 42.7 })).toContain("Downloading update v0.4.0 · 42.7%");
  });

  it("offers restart once the update is ready", () => {
    expect(render({ event: "ready", version: "0.4.0" })).toContain("Restart to update v0.4.0");
  });
});
