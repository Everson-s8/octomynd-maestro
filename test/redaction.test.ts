import { describe, expect, it } from "vitest";
import { containsSensitiveText, redactSensitiveText, truncateForDisplay } from "../src/security/redaction.js";

describe("redactSensitiveText", () => {
  it("redacts API keys, bot tokens and private key headers", () => {
    const fakeAnthropicKey = `${["sk", "ant"].join("-")}-${"a".repeat(24)}`;
    const fakeOpenAiKey = `${["sk", "proj"].join("-")}-${"b".repeat(24)}`;
    const fakeGithubToken = ["ghp", "c".repeat(24)].join("_");
    const fakeBotToken = ["123456789", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"].join(":");
    const fakePrivateKeyHeader = ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" ");

    expect(redactSensitiveText(fakeAnthropicKey)).toBe("[REDACTED_SECRET]");
    expect(redactSensitiveText(fakeOpenAiKey)).toBe("[REDACTED_SECRET]");
    expect(redactSensitiveText(fakeGithubToken)).toBe("[REDACTED_SECRET]");
    expect(redactSensitiveText(fakeBotToken)).toBe("[REDACTED_SECRET]");
    expect(redactSensitiveText(fakePrivateKeyHeader)).toBe("[REDACTED_SECRET]");
  });

  it("redacts real local filesystem paths without swallowing the rest of the message", () => {
    const windowsMessage = "Task workspace does not exist: C:\\Users\\evers\\Documents\\worktree\\task-9 for retry";
    const unixMessage = "Failed to load config from /home/evers/.claude/projects/config.json during setup";

    expect(redactSensitiveText(windowsMessage)).toBe("Task workspace does not exist: [REDACTED_LOCAL_PATH] for retry");
    expect(redactSensitiveText(unixMessage)).toBe("Failed to load config from [REDACTED_LOCAL_PATH] during setup");
  });

  it("does not treat task or branch text mentioning route-like paths as a false positive", () => {
    const taskText = "ajustar rota /home/dashboard e revisar o menu principal";
    const branchName = "maestro/task-10-melhorar-a-telemetria-operacional-dos-providers";
    const apiRouteTask = "adicionar validacao no endpoint /Users/dashboard antes do deploy";

    expect(redactSensitiveText(taskText)).toBe(taskText);
    expect(redactSensitiveText(branchName)).toBe(branchName);
    expect(redactSensitiveText(apiRouteTask)).toBe(apiRouteTask);
    expect(containsSensitiveText(taskText)).toBe(false);
    expect(containsSensitiveText(branchName)).toBe(false);
  });

  it("still flags deep unix paths that look like a real user directory", () => {
    expect(containsSensitiveText("/Users/evers/Documents/secret-notes.txt")).toBe(true);
  });
});

describe("truncateForDisplay", () => {
  it("keeps short text untouched", () => {
    expect(truncateForDisplay("short text", 100)).toBe("short text");
  });

  it("bounds oversized previews with a visible marker", () => {
    const huge = "x".repeat(5_000);
    const truncated = truncateForDisplay(huge, 300);

    expect(truncated.length).toBe(300);
    expect(truncated.endsWith("... [truncado]")).toBe(true);
  });
});
