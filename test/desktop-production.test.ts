import { describe, expect, it } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";
import { loadConfig, validateRuntimeConfig } from "../src/config.js";

const require = createRequire(import.meta.url);
const production = require("../src/desktop/production.cjs") as typeof import("../src/desktop/production.cjs");

describe("desktop production runtime logic", () => {
  it("resolves packaged backend and UI paths from the app root", () => {
    const paths = production.resolveDesktopRuntimePaths({
      isPackaged: true,
      appPath: path.join("C:", "Program Files", "Maestro", "resources", "app"),
      cwd: "/should-be-ignored"
    });

    expect(paths.appRoot).toBe(path.join("C:", "Program Files", "Maestro", "resources", "app"));
    expect(paths.backendEntry).toBe(path.join(paths.appRoot, "dist", "index.js"));
    expect(paths.uiDist).toBe(path.join(paths.appRoot, "ui", "dist"));
  });

  it("falls back to cwd when not packaged", () => {
    const paths = production.resolveDesktopRuntimePaths({
      isPackaged: false,
      appPath: "/ignored",
      cwd: path.join("D:", "checkout")
    });
    expect(paths.appRoot).toBe(path.join("D:", "checkout"));
  });

  it("uses userData for the data dir and honors an explicit override", () => {
    const userData = path.join("C:", "Users", "dev", "AppData", "Roaming", "Maestro");
    expect(production.resolveDataDir({ userData, env: {} })).toBe(path.resolve(userData));

    const override = path.join("E:", "maestro-data");
    expect(production.resolveDataDir({ userData, env: { MAESTRO_DATA_DIR: override } })).toBe(
      path.resolve(override)
    );
  });

  it("builds a backend spawn config that runs Electron as Node without Telegram", () => {
    const spawnConfig = production.buildBackendSpawnConfig({
      execPath: path.join("C:", "Program Files", "Maestro", "Maestro.exe"),
      backendEntry: path.join("app", "dist", "index.js"),
      uiDist: path.join("app", "ui", "dist"),
      runtimeRoot: path.join("app"),
      dataDir: path.join("data", "maestro"),
      host: "127.0.0.1",
      port: "4787",
      env: { EXISTING: "1", ELECTRON_RUN_AS_NODE: "should-be-overwritten" }
    });

    expect(spawnConfig.command).toBe(path.join("C:", "Program Files", "Maestro", "Maestro.exe"));
    expect(spawnConfig.args).toEqual([path.join("app", "dist", "index.js")]);
    expect(spawnConfig.options.cwd).toBe(path.join("data", "maestro"));
    expect(spawnConfig.options.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(spawnConfig.options.env.MAESTRO_REQUIRE_TELEGRAM).toBe("false");
    expect(spawnConfig.options.env.MAESTRO_DASHBOARD_HOST).toBe("127.0.0.1");
    expect(spawnConfig.options.env.MAESTRO_DASHBOARD_PORT).toBe("4787");
    expect(spawnConfig.options.env.MAESTRO_UI_DIST).toBe(path.join("app", "ui", "dist"));
    expect(spawnConfig.options.env.MAESTRO_RUNTIME_ROOT).toBe(path.join("app"));
    expect(spawnConfig.options.env.MAESTRO_RUNTIME_MODE).toBe("packaged");
    expect(spawnConfig.options.env.MAESTRO_DATA_DIR).toBe(path.join("data", "maestro"));
    expect(spawnConfig.options.env.EXISTING).toBe("1");
  });

  it("normalizes an invalid port back to the default", () => {
    const spawnConfig = production.buildBackendSpawnConfig({
      execPath: "electron",
      backendEntry: "entry.js",
      uiDist: "ui",
      dataDir: "data",
      host: "",
      port: "not-a-port",
      env: {}
    });
    expect(spawnConfig.options.env.MAESTRO_DASHBOARD_PORT).toBe("4787");
    expect(spawnConfig.host).toBe("127.0.0.1");
  });

  it("only seeds .env.local when absent and a template exists", () => {
    const dataDir = path.join("data", "maestro");
    const template = path.join("app", ".env.example");
    const target = path.join(dataDir, ".env.local");

    const seed = production.resolveEnvSeedPlan({
      dataDir,
      templatePath: template,
      fsExists: (p: string) => p === template
    });
    expect(seed).toEqual({ shouldSeed: true, target, template });

    const existing = production.resolveEnvSeedPlan({
      dataDir,
      templatePath: template,
      fsExists: () => true
    });
    expect(existing.shouldSeed).toBe(false);

    const noTemplate = production.resolveEnvSeedPlan({
      dataDir,
      templatePath: template,
      fsExists: () => false
    });
    expect(noTemplate.shouldSeed).toBe(false);
  });

  it("resolves the dashboard load URL", () => {
    expect(production.resolveLoadUrl("127.0.0.1", 4787)).toBe("http://127.0.0.1:4787/");
    expect(production.resolveLoadUrl("", "bad")).toBe("http://127.0.0.1:4787/");
  });

  it("classifies release channels for HG dev vs main production", () => {
    expect(production.resolveReleaseChannel({ MAESTRO_RELEASE_CHANNEL: "dev" })).toBe("dev");
    expect(production.resolveReleaseChannel({ MAESTRO_RELEASE_CHANNEL: "development" })).toBe("dev");
    expect(production.resolveReleaseChannel({ MAESTRO_RELEASE_CHANNEL: "prod" })).toBe("prod");
    expect(production.resolveReleaseChannel({})).toBe("prod");
  });
});

describe("desktop runtime boots without Telegram", () => {
  it("omits the Telegram token error when Telegram is not required", () => {
    const config = loadConfig(process.cwd(), {});
    const errors = validateRuntimeConfig(config, {}, { requireTelegram: false });
    expect(errors).not.toContain("TELEGRAM_BOT_TOKEN is missing. Set it in .env.local.");
  });
});
