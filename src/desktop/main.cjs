/* Production Electron main process for the packaged Maestro desktop app.
 *
 * This entry is used ONLY by the installed application (electron-builder points
 * `package.json#main` here). The developer `maestro desktop` command keeps
 * using `src/desktop/index.js`, which loads a URL against a backend the CLI
 * starts via tsx. Here there is no tsx/npm/node on the machine, so this process
 * owns the backend lifecycle:
 *   1. resolve per-user data dir (config + credentials + db live there)
 *   2. seed a secret-free `.env.local` on first run
 *   3. spawn the compiled backend with the app's Electron-as-Node runtime
 *   4. wait for the dashboard API to become healthy
 *   5. open the window against the local dashboard
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const {
  resolveDesktopRuntimePaths,
  resolveDataDir,
  buildBackendSpawnConfig,
  resolveEnvSeedPlan,
  resolveLoadUrl,
  resolveReleaseChannel
} = require("./production.cjs");

const HOST = process.env.MAESTRO_DASHBOARD_HOST || "127.0.0.1";
const PORT = process.env.MAESTRO_DASHBOARD_PORT || "4787";
const HEALTH_TIMEOUT_MS = 60_000;

let backendProcess = null;

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
    void shell.openExternal(url.toString());
    return true;
  } catch {
    return false;
  }
}

function configureExternalLinkHandling(window, localOrigin) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url, localOrigin)) {
      openExternalUrl(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isExternalHttpUrl(url, localOrigin)) {
      event.preventDefault();
      openExternalUrl(url);
    }
  });
}

ipcMain.handle("maestro:open-external", (_event, value) => openExternalUrl(value));

function checkHealth(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/api/health`, { timeout: timeoutMs }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealth(host, port) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await checkHealth(host, port, 1_000)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function seedEnvFile(dataDir, appRoot) {
  const plan = resolveEnvSeedPlan({
    dataDir,
    templatePath: path.join(appRoot, ".env.example"),
    fsExists: fs.existsSync
  });
  if (!plan.shouldSeed) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(plan.template, plan.target);
  } catch (error) {
    console.error("[maestro] Failed to seed .env.local:", error && error.message);
  }
}

function startBackend(paths, dataDir) {
  const spawnConfig = buildBackendSpawnConfig({
    execPath: process.execPath,
    backendEntry: paths.backendEntry,
    uiDist: paths.uiDist,
    runtimeRoot: paths.appRoot,
    dataDir,
    host: HOST,
    port: PORT,
    env: process.env
  });

  backendProcess = spawn(spawnConfig.command, spawnConfig.args, spawnConfig.options);
  backendProcess.stdout?.on("data", (chunk) => process.stdout.write(`[backend] ${chunk}`));
  backendProcess.stderr?.on("data", (chunk) => process.stderr.write(`[backend] ${chunk}`));
  backendProcess.on("exit", (code) => {
    backendProcess = null;
    if (code && code !== 0 && !app.isReady()) {
      // Startup failure before the window ever opened.
      console.error(`[maestro] Backend exited with code ${code}`);
    }
  });
  return spawnConfig;
}

function stopBackend() {
  if (!backendProcess) return;
  try {
    backendProcess.kill();
  } catch {
    // Already gone.
  }
  backendProcess = null;
}

function resolveWindowIconPath() {
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, "maestro.ico") : null,
    path.join(__dirname, "..", "..", "build", "maestro.ico")
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || undefined;
}

function createWindow() {
  if (process.platform !== "darwin" && typeof Menu?.setApplicationMenu === "function") {
    Menu.setApplicationMenu(null);
  }
  const channel = resolveReleaseChannel(process.env);
  const windowOptions = {
    width: 1280,
    height: 800,
    title: channel === "dev" ? "Maestro (dev)" : "Maestro",
    backgroundColor: "#0f172a",
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs")
    }
  };
  const iconPath = resolveWindowIconPath();
  if (iconPath) windowOptions.icon = iconPath;
  const window = new BrowserWindow(windowOptions);
  const loadUrl = resolveLoadUrl(HOST, PORT);
  configureExternalLinkHandling(window, new URL(loadUrl).origin);
  window.loadURL(loadUrl);
  return window;
}

async function bootstrap() {
  const paths = resolveDesktopRuntimePaths({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    cwd: process.cwd()
  });
  // A packaged app must be isolated per Windows user. Do not honor a
  // MAESTRO_DATA_DIR inherited from the developer's shell or machine-wide
  // environment; that override remains available to local/CLI workflows.
  const dataDir = app.isPackaged
    ? path.resolve(app.getPath("userData"))
    : resolveDataDir({ userData: app.getPath("userData"), env: process.env });

  seedEnvFile(dataDir, paths.appRoot);

  if (!(await checkHealth(HOST, PORT, 1_000))) {
    startBackend(paths, dataDir);
    const healthy = await waitForHealth(HOST, PORT);
    if (!healthy) {
      dialog.showErrorBox(
        "Maestro",
        "O serviço do Maestro não respondeu a tempo. Verifique os logs e reabra o aplicativo."
      );
      stopBackend();
      app.quit();
      return;
    }
  }

  createWindow();

  // F6: auto-update (packaged builds only; inert in development).
  if (app.isPackaged) {
    try {
      const { initAutoUpdate } = require("./auto-updater.cjs");
      initAutoUpdate({ mainWindow: BrowserWindow.getAllWindows()[0] ?? null });
    } catch (updateError) {
      console.error("[maestro] auto-update unavailable:", updateError?.message ?? updateError);
    }
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  stopBackend();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", stopBackend);
process.on("exit", stopBackend);
