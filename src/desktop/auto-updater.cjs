/**
 * F6: auto-update support via electron-updater.
 *
 * Update flow (matches Hermes/VS Code semantics the user expects):
 *  - The packaged app checks the GitHub Releases feed on boot and every 6h.
 *  - When a newer version is found it is downloaded in the background.
 *  - The user is told once ("Update downloaded — restart to apply");
 *    quitAndInstall() replaces the app in place. User data under userData
 *    is preserved, exactly like the manual Setup-over-Setup flow.
 *
 * In development (`!app.isPackaged`) this module is inert — electron-updater
 * refuses to run against unpacked apps anyway.
 */
let autoUpdater = null;

function initAutoUpdate({ mainWindow } = {}) {
  if (!process.env.ELECTRON_RUN_AS_NODE && process.defaultApp) return null;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    // electron-updater not installed (e.g. dev checkout without deps).
    return null;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // No dev-app-update.yml needed: updates only run when packaged.
  autoUpdater.disableWebInstaller = true;

  const notify = (message) => {
    try {
      mainWindow?.webContents?.send("maestro:update-status", message);
    } catch {
      /* window may be gone; console fallback */
    }
  };

  autoUpdater.on("checking-for-update", () => notify({ event: "checking" }));
  autoUpdater.on("update-not-available", (info) =>
    notify({ event: "up_to_date", version: info?.version ?? null }));
  autoUpdater.on("update-available", (info) =>
    notify({ event: "downloading", version: info?.version ?? null }));
  autoUpdater.on("download-progress", (progress) =>
    notify({ event: "progress", percent: Math.round(progress?.percent ?? 0) }));
  autoUpdater.on("update-downloaded", (info) => {
    notify({ event: "ready", version: info?.version ?? null });
  });
  autoUpdater.on("error", (error) =>
    notify({ event: "error", message: String(error?.message ?? error) }));

  void autoUpdater.checkForUpdates().catch(() => {
    // Offline / private repo / no releases yet — silent, checked again later.
  });
  setInterval(() => {
    void autoUpdater.checkForUpdates().catch(() => undefined);
  }, 6 * 60 * 60 * 1000);

  return autoUpdater;
}

module.exports = { initAutoUpdate };
