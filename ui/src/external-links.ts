type DesktopBridge = {
  openExternal?: (url: string) => Promise<unknown>;
};

type DesktopWindow = Window & {
  maestroDesktop?: DesktopBridge;
};

export function isOpenableExternalUrl(value: string): boolean {
  try {
    const base = typeof window === "undefined" ? "http://127.0.0.1/" : window.location.href;
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Open a provider/GitHub/docs link outside the Electron shell. In a normal
 * browser the same helper keeps the expected new-tab behavior, with a same-tab
 * fallback when a popup blocker rejects an automatic open.
 */
export function openExternalUrl(value: string, automatic = false): void {
  if (!isOpenableExternalUrl(value)) return;
  const base = typeof window === "undefined" ? "http://127.0.0.1/" : window.location.href;
  const url = new URL(value, base).toString();
  if (typeof window === "undefined") return;
  const bridge = (window as DesktopWindow).maestroDesktop;
  if (bridge?.openExternal) {
    void bridge.openExternal(url).catch(() => undefined);
    return;
  }

  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened && automatic) window.location.assign(url);
}
