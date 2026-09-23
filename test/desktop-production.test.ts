import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { loadConfig, validateRuntimeConfig } from "../src/config.js";
import { parse } from "yaml";

const require = createRequire(import.meta.url);
const production = require("../src/desktop/production.cjs") as typeof import("../src/desktop/production.cjs") & {
  DEFAULT_HEALTH_SERVICE: string;
  DEFAULT_HEALTH_RUNTIME_MODE: string;
  checkHealth: (
    host: string,
    port: number,
    timeoutMs: number,
    expected?: { service?: string; runtimeMode?: string }
  ) => Promise<{ status: string }>;
  formatHealthConflictMessage: (host: string, port: number, result: { status: string }) => string;
};
const updater = require("../src/desktop/auto-updater.cjs") as {
  initAutoUpdate: (options: Record<string, unknown>) => unknown;
};

describe("desktop production runtime logic", () => {
  async function startHealthServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("health test server did not expose a TCP port");
    return { server, port: address.port };
  }

  async function closeServer(server: http.Server): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  it("packages the updater entry without broad desktop source globs", () => {
    const builderConfig = parse(fs.readFileSync(path.resolve(process.cwd(), "electron-builder.yml"), "utf8")) as {
      files: string[];
    };

    expect(builderConfig.files).toContain("src/desktop/auto-updater.cjs");
    expect(builderConfig.files).toContain("src/desktop/production.cjs");
    expect(builderConfig.files).toContain("skills/**/*");
    expect(builderConfig.files).not.toContain("src/desktop/**/*");
    expect(builderConfig.files).toContain("!**/*.map");
    expect(builderConfig.files).toContain("!**/*.ts");
    expect(builderConfig.files).toContain("!test/**");
    expect(() => require("../src/desktop/auto-updater.cjs")).not.toThrow();
  });

  it("surfaces updater check failures to the desktop window and error log", async () => {
    const listeners = new Map<string, (payload?: unknown) => void>();
    const sent: unknown[] = [];
    const errors: unknown[][] = [];
    const fakeUpdater = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      disableWebInstaller: false,
      on(event: string, listener: (payload?: unknown) => void) {
        listeners.set(event, listener);
        return this;
      },
      checkForUpdates: () => Promise.reject(new Error("GitHub release feed unavailable"))
    };

    updater.initAutoUpdate({
      updater: fakeUpdater,
      logger: { error: (...args: unknown[]) => errors.push(args) },
      mainWindow: {
        webContents: {
          send: (_channel: string, payload: unknown) => sent.push(payload)
        }
      }
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(errors).toContainEqual(["[maestro] automatic update failed:", "GitHub release feed unavailable"]);
    expect(sent).toContainEqual({ event: "error", message: "GitHub release feed unavailable" });
    expect(listeners.has("error")).toBe(true);
  });

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
    expect(spawnConfig.options.env.MAESTRO_SKILLS_PATH).toBe(path.join("app", "skills"));
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

  it("rejects a 200 response from an impostor process", async () => {
    const { server, port } = await startHealthServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "outro-programa-qualquer", runtimeMode: "full" }));
    });

    try {
      const result = await production.checkHealth("127.0.0.1", port, 250, {
        service: production.DEFAULT_HEALTH_SERVICE,
        runtimeMode: production.DEFAULT_HEALTH_RUNTIME_MODE
      });
      expect(result.status).toBe("wrong_identity");
    } finally {
      await closeServer(server);
    }
  });

  it("accepts the legitimate Maestro health contract", async () => {
    const { server, port } = await startHealthServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "octomynd-maestro", runtimeMode: "full" }));
    });

    try {
      const result = await production.checkHealth("127.0.0.1", port, 250, {
        service: production.DEFAULT_HEALTH_SERVICE,
        runtimeMode: production.DEFAULT_HEALTH_RUNTIME_MODE
      });
      expect(result.status).toBe("healthy");
    } finally {
      await closeServer(server);
    }
  });

  it("rejects a Maestro process running in the wrong runtime mode", async () => {
    const { server, port } = await startHealthServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "octomynd-maestro", runtimeMode: "dashboard" }));
    });

    try {
      const result = await production.checkHealth("127.0.0.1", port, 250, {
        service: production.DEFAULT_HEALTH_SERVICE,
        runtimeMode: production.DEFAULT_HEALTH_RUNTIME_MODE
      });
      expect(result.status).toBe("wrong_identity");
    } finally {
      await closeServer(server);
    }
  });

  it("rejects non-JSON health responses without hanging", async () => {
    const { server, port } = await startHealthServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("not Maestro");
    });

    try {
      const result = await production.checkHealth("127.0.0.1", port, 250, {
        service: production.DEFAULT_HEALTH_SERVICE,
        runtimeMode: production.DEFAULT_HEALTH_RUNTIME_MODE
      });
      expect(result.status).toBe("invalid_response");
    } finally {
      await closeServer(server);
    }
  });

  it("bounds a slow health response by the request timeout", async () => {
    const { server, port } = await startHealthServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, service: "octomynd-maestro", runtimeMode: "full" }));
      }, 150);
    });

    try {
      const startedAt = Date.now();
      const result = await production.checkHealth("127.0.0.1", port, 25, {
        service: production.DEFAULT_HEALTH_SERVICE,
        runtimeMode: production.DEFAULT_HEALTH_RUNTIME_MODE
      });
      expect(result.status).toBe("timeout");
      expect(Date.now() - startedAt).toBeLessThan(125);
    } finally {
      await closeServer(server);
    }
  });

  it("explains how to recover from an occupied port", () => {
    const message = production.formatHealthConflictMessage("127.0.0.1", 4787, { status: "wrong_identity" });
    expect(message).toContain("http://127.0.0.1:4787");
    expect(message).toContain("Close the other program");
    expect(message).toContain("MAESTRO_DASHBOARD_PORT");
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
