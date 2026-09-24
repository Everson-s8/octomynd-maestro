import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderTerminalWelcome } from "../src/cli/terminal-ui.js";
import { cliDataDir, envDbPath, PACKAGED_USER_DATA_DIRECTORY_NAME } from "../src/cli/env.js";

describe("Maestro terminal experience", () => {
  it("renders the branded chat welcome with live project, providers, and queue values", () => {
    const output = renderTerminalWelcome({
      projectKey: "apto_gerenciamento",
      version: "0.4.1",
      providers: [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude Code" }],
      queuedTasks: 3,
      runningTasks: 1,
      color: false,
      width: 108
    }).join("\n");

    expect(output).toContain("Octomynd Maestro v0.4.1 · local");
    expect(output).toContain("Codex, Claude Code");
    expect(output).toContain("3 aguardando · 1 em execução");
    expect(output).toContain("@apto_gerenciamento");
    expect(output).toContain("Descreva a tarefa para o Maestro");
    expect(output).not.toContain("78%");
  });

  it("shows an empty, honest state instead of inventing connected providers", () => {
    const output = renderTerminalWelcome({
      projectKey: "maestro",
      version: "0.4.1",
      providers: [],
      queuedTasks: 0,
      runningTasks: 0,
      color: false
    }).join("\n");

    expect(output).toContain("nenhum conectado");
    expect(output).toContain("0 aguardando · 0 em execução");
  });

  it("preserves the terminal layout when color is disabled", () => {
    const output = renderTerminalWelcome({
      projectKey: "demo",
      version: "0.4.1",
      providers: [],
      queuedTasks: 0,
      runningTasks: 0,
      color: false
    }).join("\n");

    expect(output).not.toContain("\u001b[");
    expect(output).toContain("╭");
    expect(output).toContain("Octomynd Maestro");
  });
});

describe("packaged CLI data directory", () => {
  const previous = {
    mode: process.env.MAESTRO_CLI_MODE,
    dataDir: process.env.MAESTRO_DATA_DIR,
    appData: process.env.APPDATA
  };

  function restoreEnv(): void {
    for (const [key, value] of Object.entries({
      MAESTRO_CLI_MODE: previous.mode,
      MAESTRO_DATA_DIR: previous.dataDir,
      APPDATA: previous.appData
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  afterEach(restoreEnv);

  it("shares the app userData directory instead of creating a separate CLI database", () => {
    const appData = path.join(process.cwd(), ".test-appdata");
    process.env.MAESTRO_CLI_MODE = "packaged";
    process.env.APPDATA = appData;
    delete process.env.MAESTRO_DATA_DIR;
    try {
      const dataDir = cliDataDir();
      expect(PACKAGED_USER_DATA_DIRECTORY_NAME).toBe("octomynd-maestro");
      expect(dataDir).toBe(path.resolve(appData, "octomynd-maestro"));
      expect(envDbPath()).toBe(path.resolve(dataDir, ".maestro", "maestro.db"));
    } finally {
      restoreEnv();
    }
  });

  it("keeps an explicit data-dir override and the developer cwd behavior", () => {
    const override = path.join(process.cwd(), ".test-maestro-override");
    process.env.MAESTRO_CLI_MODE = "packaged";
    process.env.APPDATA = path.join(process.cwd(), ".test-appdata");
    process.env.MAESTRO_DATA_DIR = override;
    try {
      expect(cliDataDir()).toBe(path.resolve(override));
    } finally {
      restoreEnv();
    }

    process.env.MAESTRO_CLI_MODE = "development";
    delete process.env.MAESTRO_DATA_DIR;
    expect(cliDataDir()).toBe(path.resolve(process.cwd()));
    restoreEnv();
  });

  it("does not retain the old %APPDATA%\\Maestro path in the installed launcher", () => {
    const launcher = fs.readFileSync(path.resolve(process.cwd(), "scripts/maestro.cmd"), "utf8");
    expect(launcher).toContain("set \"MAESTRO_CLI_MODE=packaged\"");
    expect(launcher).not.toContain("%APPDATA%\\Maestro");
  });
});
