import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  testTelegramBotToken,
  updateEnvTelegramConfig,
  validateTelegramBotToken,
  validateTelegramUserId
} from "../src/telegram/connect.js";
import { TelegramSubsystemManager } from "../src/telegram/bot.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { createDatabase } from "../src/db.js";
import { MaestroConfig } from "../src/config.js";

const VALID_TEST_BOT_TOKEN = ["123456789", "ABCdefGhIJKlmNoPQRsTUVwxyZ123456"].join(":");
const VALID_TEST_BOT_TOKEN_2 = ["123456789", "TestTokenSecret123456789012345"].join(":");

describe("Telegram Connect Subsystem", () => {
  it("validates Telegram Bot Token format correctly", () => {
    expect(validateTelegramBotToken("").valid).toBe(false);
    expect(validateTelegramBotToken("dummy_token_for_local_setup").valid).toBe(false);
    expect(validateTelegramBotToken("invalid-token").valid).toBe(false);
    expect(validateTelegramBotToken(VALID_TEST_BOT_TOKEN).valid).toBe(true);
  });

  it("validates Telegram User ID format correctly", () => {
    expect(validateTelegramUserId("").valid).toBe(true);
    expect(validateTelegramUserId("  ").valid).toBe(true);
    expect(validateTelegramUserId("abc123").valid).toBe(false);
    expect(validateTelegramUserId("123456789").valid).toBe(true);
  });

  it("updates .env file safely preserving other variables", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-env-test-"));
    const envPath = path.join(tmpDir, ".env");

    const initialContent = [
      "# Existing comment",
      "MAESTRO_PROJECT_NAME=test-project",
      "TELEGRAM_BOT_TOKEN=dummy_token_for_local_setup",
      "TELEGRAM_ALLOWED_USER_ID=",
      "FOO=BAR"
    ].join("\n");

    fs.writeFileSync(envPath, initialContent, "utf8");

    const result = updateEnvTelegramConfig({
      botToken: VALID_TEST_BOT_TOKEN_2,
      allowedUserId: "987654321",
      targetFile: envPath
    });

    expect(result.success).toBe(true);

    const updatedContent = fs.readFileSync(envPath, "utf8");
    expect(updatedContent).toContain("MAESTRO_PROJECT_NAME=test-project");
    expect(updatedContent).toContain("FOO=BAR");
    expect(updatedContent).toContain(`TELEGRAM_BOT_TOKEN=${VALID_TEST_BOT_TOKEN_2}`);
    expect(updatedContent).toContain("TELEGRAM_ALLOWED_USER_ID=987654321");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles TelegramSubsystemManager lifecycle without crash", async () => {
    const config: MaestroConfig = {
      projectName: "test",
      databasePath: ":memory:",
      worktreesPath: "/tmp",
      dashboard: { host: "127.0.0.1", port: 0, enabled: true },
      execution: {
        rootPath: "/tmp",
        worktreesPath: "/tmp",
        expectedNodeVersion: "20",
        supportedNodeRange: ">=20.17.0 <25"
      },
      runtime: { providerMaxRuntimeMs: 1000, codexInactivityTimeoutMs: 1000, claudeInactivityTimeoutMs: 1000, antigravityInactivityTimeoutMs: 1000, antigravityEnabled: true, antigravityModel: "gemini-2.5-pro", tokenEfficient: true, goalDeadlineMs: 60000, selfUpdatePollIntervalMs: 60000 },
      skills: { enabled: false, catalogPath: "", versionsPath: "", projectKey: "test", curator: { staleDays: 30, autoArchiveEnabled: false, pollIntervalMs: 60000 } },
      autopilot: { enabled: false, pollIntervalMs: 1000, maxConcurrentGoals: 1 },
      workGraph: { adoptionMode: "off" },
      telegram: { botToken: "", allowedUserId: null }
    };

    const db = createDatabase(":memory:");
    const manager = new TelegramSubsystemManager(config, db);

    expect(manager.isBotRunning()).toBe(false);
    const started = await manager.start();
    expect(started).toBe(false); // empty token should not start

    await manager.stop();
  });

  it("serves POST /api/telegram/connect endpoint with validation errors", async () => {
    const config: MaestroConfig = {
      projectName: "test",
      databasePath: ":memory:",
      worktreesPath: "/tmp",
      dashboard: { host: "127.0.0.1", port: 0, enabled: true },
      execution: {
        rootPath: "/tmp",
        worktreesPath: "/tmp",
        expectedNodeVersion: "20",
        supportedNodeRange: ">=20.17.0 <25"
      },
      runtime: { providerMaxRuntimeMs: 1000, codexInactivityTimeoutMs: 1000, claudeInactivityTimeoutMs: 1000, antigravityInactivityTimeoutMs: 1000, antigravityEnabled: true, antigravityModel: "gemini-2.5-pro", tokenEfficient: true, goalDeadlineMs: 60000, selfUpdatePollIntervalMs: 60000 },
      skills: { enabled: false, catalogPath: "", versionsPath: "", projectKey: "test", curator: { staleDays: 30, autoArchiveEnabled: false, pollIntervalMs: 60000 } },
      autopilot: { enabled: false, pollIntervalMs: 1000, maxConcurrentGoals: 1 },
      workGraph: { adoptionMode: "off" },
      telegram: { botToken: "", allowedUserId: null }
    };

    const db = createDatabase(":memory:");
    const server = createDashboardServer({ config, database: db });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };

    // Test invalid token format
    const res1 = await fetch(`http://127.0.0.1:${address.port}/api/telegram/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken: "invalid_token" })
    });
    expect(res1.status).toBe(400);
    const body1 = await res1.json();
    expect(body1.error).toBe("validation_failed");

    // Test invalid user ID format
    const res2 = await fetch(`http://127.0.0.1:${address.port}/api/telegram/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken: VALID_TEST_BOT_TOKEN, allowedUserId: "abc" })
    });
    expect(res2.status).toBe(400);
    const body2 = await res2.json();
    expect(body2.error).toBe("validation_failed");

    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
});
