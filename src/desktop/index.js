let electronModule = {};
try {
  electronModule = await import("electron");
} catch {
  // Environment without active Electron runtime (e.g. Node unit tests)
}

const { app, BrowserWindow } = electronModule;

export function getDesktopWindowOptions() {
  return {
    width: 1280,
    height: 800,
    title: "Maestro",
    backgroundColor: "#0f172a",
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  };
}

// Orchestrator server (src/dashboard/server.ts) serves ui/dist and /api/*
// from the same origin, so loading it directly avoids file:// CORS issues.
export function resolveDesktopLoadUrl(apiHost = "127.0.0.1", apiPort = "4787") {
  return `http://${apiHost}:${apiPort}/`;
}

function createWindow() {
  if (!BrowserWindow) return;
  // Remove the native menu bar (File/Edit/View) so the app renders as a
  // single-content desktop app, like other local tools.
  const { Menu } = electronModule;
  if (typeof Menu?.setApplicationMenu === "function") {
    Menu.setApplicationMenu(null);
  }
  const options = getDesktopWindowOptions();
  const mainWindow = new BrowserWindow(options);

  const apiPort = process.env.MAESTRO_API_PORT || "4787";
  const apiHost = process.env.MAESTRO_API_HOST || "127.0.0.1";

  mainWindow.loadURL(resolveDesktopLoadUrl(apiHost, apiPort));
}

if (app && typeof app.whenReady === "function") {
  app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow && BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && typeof app.quit === "function") app.quit();
  });
}
