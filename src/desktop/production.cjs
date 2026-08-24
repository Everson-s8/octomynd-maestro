/* Pure, Electron-free logic for the packaged Maestro desktop runtime.
 *
 * The production Electron main process (`main.cjs`) is thin and hard to unit
 * test because it imports `electron`. This module keeps every decision that
 * does NOT require the Electron runtime — path resolution, backend spawn
 * configuration, config seeding, release channel — as plain CommonJS so it can
 * be exercised by vitest and reused by `main.cjs`.
 *
 * Packaging model (see electron-builder.yml):
 *   - `asar: false`, so the app files live unpacked under `resources/app/`.
 *   - The compiled backend (`dist/index.js`) is spawned as a child process
 *     using the app's own Electron binary with `ELECTRON_RUN_AS_NODE=1`. This
 *     means no external Node/npm/tsx needs to exist on the target machine.
 *     Git and provider CLIs remain integration prerequisites for task work.
 *   - User config, credentials and the SQLite database live under the OS
 *     per-user data directory (Electron `userData`), never inside the install
 *     folder, so updates never clobber them and no secret ships in the build.
 */

const path = require("node:path");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4787;

/**
 * Resolve the on-disk locations of the packaged backend entry and built UI.
 *
 * @param {{ isPackaged: boolean, appPath: string, cwd?: string }} input
 *   - `appPath` is Electron's `app.getAppPath()` (the app root inside the
 *     installed program folder). Ignored when not packaged.
 *   - `cwd` is used as the app root during local (unpackaged) runs.
 */
function resolveDesktopRuntimePaths(input) {
  const appRoot = input.isPackaged ? input.appPath : (input.cwd || process.cwd());
  return {
    appRoot,
    backendEntry: path.join(appRoot, "dist", "index.js"),
    uiDist: path.join(appRoot, "ui", "dist")
  };
}

/**
 * The per-user directory that holds config, credentials and the database.
 * An explicit `MAESTRO_DATA_DIR` always wins for local/CLI runs so power users
 * and CI can pin a location; the packaged desktop entry point deliberately
 * resolves its directory from Electron's userData path instead.
 */
function resolveDataDir(input) {
  const override = input.env && input.env.MAESTRO_DATA_DIR && String(input.env.MAESTRO_DATA_DIR).trim();
  if (override) return path.resolve(override);
  return path.resolve(input.userData);
}

/**
 * Build the child-process spawn descriptor for the compiled backend. Running
 * the Electron binary with `ELECTRON_RUN_AS_NODE=1` gives a Node runtime with
 * the exact ABI `better-sqlite3` was rebuilt against, with zero external
 * toolchain on the machine.
 */
function buildBackendSpawnConfig(input) {
  const host = (input.host && String(input.host).trim()) || DEFAULT_HOST;
  const port = normalizePort(input.port, DEFAULT_PORT);
  const baseEnv = { ...(input.env || {}) };

  // Strip anything that would make the child re-enter the GUI Electron path.
  delete baseEnv.ELECTRON_RUN_AS_NODE;

  const childEnv = {
    ...baseEnv,
    ELECTRON_RUN_AS_NODE: "1",
    MAESTRO_DASHBOARD_HOST: host,
    MAESTRO_DASHBOARD_PORT: String(port),
    // The desktop app boots the full orchestrator without Telegram; the user
    // wires Telegram later from the dashboard if they want it.
    MAESTRO_REQUIRE_TELEGRAM: "false",
    // Point the static file server at the packaged UI regardless of cwd.
    MAESTRO_UI_DIST: input.uiDist,
    // Make the runtime mode explicit. MAESTRO_RUNTIME_ROOT is also used for
    // locating the bundled toolchain, so it must not be used as a proxy for
    // deciding whether the target project is running inside the packaged app.
    MAESTRO_RUNTIME_MODE: "packaged",
    // Never let a MAESTRO_DATA_DIR from the build machine or a developer's
    // shell redirect a shared desktop install to another user's credentials.
    // main.cjs resolves this to Electron's per-user userData directory.
    MAESTRO_DATA_DIR: input.dataDir,
    // The packaged toolchain (TypeScript/Vitest/Vite) lives beside the
    // compiled backend. The backend cwd is user data, so expose the app root
    // explicitly for Environment Doctor and deterministic validation.
    MAESTRO_RUNTIME_ROOT: input.runtimeRoot || path.dirname(path.dirname(input.backendEntry))
  };

  return {
    command: input.execPath,
    args: [input.backendEntry],
    options: {
      cwd: input.dataDir,
      env: childEnv,
      windowsHide: true
    },
    host,
    port
  };
}

/**
 * Decide whether a starter `.env.local` should be copied into the data dir.
 * The template is the committed `.env.example`, which contains NO secrets.
 * We never overwrite an existing user file.
 */
function resolveEnvSeedPlan(input) {
  const target = path.join(input.dataDir, ".env.local");
  if (input.fsExists(target)) {
    return { shouldSeed: false, target, template: input.templatePath };
  }
  if (!input.fsExists(input.templatePath)) {
    return { shouldSeed: false, target, template: input.templatePath };
  }
  return { shouldSeed: true, target, template: input.templatePath };
}

function resolveLoadUrl(host, port) {
  const safeHost = (host && String(host).trim()) || DEFAULT_HOST;
  const safePort = normalizePort(port, DEFAULT_PORT);
  return `http://${safeHost}:${safePort}/`;
}

/**
 * Release channel keeps HG development builds visibly distinct from `main`
 * production builds. `MAESTRO_RELEASE_CHANNEL=dev` marks a development build;
 * anything else (or unset) is treated as production.
 */
function resolveReleaseChannel(env) {
  const raw = env && env.MAESTRO_RELEASE_CHANNEL ? String(env.MAESTRO_RELEASE_CHANNEL).trim().toLowerCase() : "";
  return raw === "dev" || raw === "development" ? "dev" : "prod";
}

function normalizePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  resolveDesktopRuntimePaths,
  resolveDataDir,
  buildBackendSpawnConfig,
  resolveEnvSeedPlan,
  resolveLoadUrl,
  resolveReleaseChannel,
  normalizePort
};
