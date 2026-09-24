import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderTerminalWelcome } from "../src/cli/terminal-ui.js";
import { cliDataDir, envDbPath, PACKAGED_USER_DATA_DIRECTORY_NAME } from "../src/cli/env.js";

describe("Maestro terminal experience", () => {
  it("renders a compact branded welcome with live project, providers, and queue values", () => {
    const output = renderTerminalWelcome({
      projectKey: "apto_gerenciamento",
      version: "0.4.1",
      providers: [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude Code" }],
      queuedTasks: 3,
      runningTasks: 1,
      color: false,
      width: 108
    }).join("\n");

    expect(output).toContain("Maestro v0.4.1 · CLI local");
    expect(output).toContain("Codex · Claude Code");
    expect(output).toContain("3 aguardando · 1 em execução");
    expect(output).toContain("@apto_gerenciamento");
    expect(output).toContain("Provedores");
    expect(output).not.toContain("8 braços");
    expect(output).not.toContain("████");
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

  it("uses a compact, colorless layout when color is disabled", () => {
    const output = renderTerminalWelcome({
      projectKey: "demo",
      version: "0.4.1",
      providers: [],
      queuedTasks: 0,
      runningTasks: 0,
      color: false
    }).join("\n");

    expect(output).not.toContain("\u001b[");
    expect(output).toContain("Maestro v0.4.1 · CLI local");
    expect(output).toContain("Descreva a tarefa ou digite /help.");
    expect(output).not.toContain("╭");
  });

  it("keeps every line within narrow terminal widths and localizes copy", () => {
    const visibleLength = (line: string) => Array.from(line.replace(/\u001b\[[0-9;]*m/g, "")).length;
    for (const width of [40, 48, 80, 108]) {
      const output = renderTerminalWelcome({
        projectKey: "an-extremely-long-project-name-that-needs-fitting",
        version: "0.4.1",
        providers: ["codex", "claude", "gemini", "openrouter"].map((id) => ({ id, label: `${id} provider` })),
        queuedTasks: 3,
        runningTasks: 1,
        width,
        color: true,
        locale: "en"
      });

      expect(output.every((line) => visibleLength(line) <= width)).toBe(true);
      expect(output.join("\n")).toContain("Describe a task or type /help.");
    }

    const wideOutput = renderTerminalWelcome({
      projectKey: "demo",
      version: "0.4.1",
      providers: ["codex", "claude", "gemini", "openrouter"].map((id) => ({ id, label: `${id} provider` })),
      queuedTasks: 0,
      runningTasks: 0,
      width: 108,
      color: true,
      locale: "en"
    }).join("\n");
    expect(wideOutput).toContain("openrouter provider");
    expect(wideOutput).toContain("\u001b[1;38;2;238;145;96m");
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
