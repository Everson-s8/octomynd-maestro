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
function initAutoUpdate({ mainWindow = null, updater: providedUpdater, logger = console } = {}) {
  if (!process.env.ELECTRON_RUN_AS_NODE && process.defaultApp) return null;
  let autoUpdater;
  try {
    autoUpdater = providedUpdater ?? require("electron-updater").autoUpdater;
  } catch (error) {
    reportUpdateFailure(error, { mainWindow, logger });
    // Let the packaged main process show its user-visible warning. The app
    // remains alive because main.cjs owns this try/catch boundary.
    throw error;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // No dev-app-update.yml needed: updates only run when packaged.
  autoUpdater.disableWebInstaller = true;

  const notify = (message) => {
    const webContents = mainWindow?.webContents;
    if (!webContents) return;
    const send = () => {
      try {
        webContents.send("maestro:update-status", message);
      } catch (error) {
        reportUpdateFailure(error, { mainWindow: null, logger });
      }
    };
    if (typeof webContents.isLoading === "function" && webContents.isLoading()) {
      webContents.once?.("did-finish-load", send);
    } else {
      send();
    }
  };

  const reportError = (error) => reportUpdateFailure(error, { mainWindow, logger, notify });

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
  autoUpdater.on("error", reportError);

  void autoUpdater.checkForUpdates().catch(reportError);
  const updateTimer = setInterval(() => {
    void autoUpdater.checkForUpdates().catch(reportError);
  }, 6 * 60 * 60 * 1000);
  updateTimer.unref?.();

  return autoUpdater;
}

function reportUpdateFailure(error, { mainWindow = null, logger = console, notify } = {}) {
  const message = String(error?.message ?? error ?? "Unknown update error");
  logger.error?.("[maestro] automatic update failed:", message);
  if (notify) {
    notify({ event: "error", message });
    return;
  }
  try {
    mainWindow?.webContents?.send("maestro:update-status", { event: "error", message });
  } catch {
    // Logging above remains the last-resort diagnostic if the window is gone.
  }
}

module.exports = { initAutoUpdate, reportUpdateFailure };
