import { describe, expect, it } from "vitest";
import { buildRestrictedAgentEnvironment, runAgentProcess } from "../src/agents/process.js";

describe("agent process runtime", () => {
  it("captures stdout, stderr and stdin through one interface", async () => {
    const result = await runAgentProcess({
      command: process.execPath,
      args: ["-e", "process.stdin.on('data', value => { console.log(value.toString().trim()); console.error('warn'); });"],
      cwd: process.cwd(),
      stdin: "hello runtime",
      timeoutMs: 2_000
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello runtime");
    expect(result.stderr).toContain("warn");
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("marks a process that exceeds its timeout", async () => {
    const result = await runAgentProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
      timeoutMs: 50
    });

    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it("marks a process cancelled through AbortSignal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const result = await runAgentProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      signal: controller.signal
    });

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("keeps only the configured output tail", async () => {
    const result = await runAgentProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('a'.repeat(200) + 'TAIL');"],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      maxOutputChars: 20
    });

    expect(result.stdout).toHaveLength(20);
    expect(result.stdout.endsWith("TAIL")).toBe(true);
  });

  it("removes credentials while preserving normal runtime variables", () => {
    const restricted = buildRestrictedAgentEnvironment({
      PATH: "C:/tools",
      APPDATA: "C:/user/appdata",
      OPENAI_API_KEY: "secret",
      TELEGRAM_BOT_TOKEN: "secret",
      DATABASE_PASSWORD: "secret",
      SAFE_SETTING: "yes"
    });

    expect(restricted).toEqual({
      PATH: "C:/tools",
      APPDATA: "C:/user/appdata",
      SAFE_SETTING: "yes"
    });
  });
});
