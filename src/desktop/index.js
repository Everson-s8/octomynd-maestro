let electronModule = {};
try {
  electronModule = await import("electron");
} catch {
  // Environment without active Electron runtime (e.g. Node unit tests)
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { app, BrowserWindow, shell, ipcMain } = electronModule;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function resolveWindowIconPath() {
  const resourcesPath = typeof process.resourcesPath === "string" ? process.resourcesPath : null;
  const candidates = [
    resourcesPath ? path.join(resourcesPath, "maestro.ico") : null,
    path.join(projectRoot, "build", "maestro.ico"),
    path.join(process.cwd(), "build", "maestro.ico")
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

export function getDesktopWindowOptions() {
  const options = {
    width: 1280,
    height: 800,
    title: "Maestro",
    backgroundColor: "#0f172a",
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(projectRoot, "src", "desktop", "preload.cjs")
    }
  };
  const iconPath = resolveWindowIconPath();
  if (iconPath) options.icon = iconPath;
  return options;
}

// Orchestrator server (src/dashboard/server.ts) serves ui/dist and /api/*
// from the same origin, so loading it directly avoids file:// CORS issues.
export function resolveDesktopLoadUrl(apiHost = "127.0.0.1", apiPort = "4787") {
  return `http://${apiHost}:${apiPort}/`;
}

function isExternalHttpUrl(value, localOrigin) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== localOrigin;
  } catch {
    return false;
  }
}

function openExternalUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    void shell?.openExternal?.(url.toString());
    return true;
  } catch {
    return false;
  }
}

if (ipcMain?.handle) {
  ipcMain.handle("maestro:open-external", (_event, value) => openExternalUrl(value));
}

function createWindow() {
  if (!BrowserWindow) return;
  // Hide the native File/Edit/View menu so the app renders as a single-content
  // desktop app. On macOS keep a minimal app menu (Quit/Hide) so Cmd+Q etc.
  // keep working — a fully-null menu strips macOS accelerators.
  const { Menu } = electronModule;
  if (typeof Menu?.setApplicationMenu === "function" && process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
  }
  const options = getDesktopWindowOptions();
  const mainWindow = new BrowserWindow(options);

  const apiPort = process.env.MAESTRO_API_PORT || "4787";
  const apiHost = process.env.MAESTRO_API_HOST || "127.0.0.1";
  const loadUrl = resolveDesktopLoadUrl(apiHost, apiPort);
  const localOrigin = new URL(loadUrl).origin;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url, localOrigin)) {
      openExternalUrl(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isExternalHttpUrl(url, localOrigin)) {
      event.preventDefault();
      openExternalUrl(url);
    }
  });
  mainWindow.loadURL(loadUrl);
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
