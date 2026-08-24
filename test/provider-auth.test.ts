import { describe, expect, it } from "vitest";

import { parseDeviceAuthorization, ProviderAuthBroker } from "../src/agents/provider-auth.js";
import type { ProviderPreset } from "../src/agents/provider-config.js";

describe("provider auth", () => {
  it("extracts a verification URL and labelled device code", () => {
    expect(
      parseDeviceAuthorization(
        "Open https://auth.example.com/device and enter code: S86N-MBA5G"
      )
    ).toEqual({
      verificationUrl: "https://auth.example.com/device",
      userCode: "S86N-MBA5G"
    });
  });

  it("extracts a standalone device code from CLI output", () => {
    expect(
      parseDeviceAuthorization(
        "Visit https://example.com/activate. Waiting for authorization... ABCD-EFGH"
      )
    ).toEqual({
      verificationUrl: "https://example.com/activate",
      userCode: "ABCD-EFGH"
    });
  });

  it("does not invent authorization details", () => {
    expect(parseDeviceAuthorization("Waiting for provider output")).toEqual({
      verificationUrl: null,
      userCode: null
    });
  });

  it("strips ANSI color codes wrapping the code and URL (real CLI output)", () => {
    const output =
      "\nWelcome to Codex \u001b[90mv0.137.0\u001b[0m\n" +
      "Follow these steps to sign in:\n" +
      "   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n" +
      "2. Enter this one-time code\n" +
      "   \u001b[94mUEJ0-ANCUR\u001b[0m\n";
    expect(parseDeviceAuthorization(output)).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "UEJ0-ANCUR"
    });
  });
});

describe("multi-flow auth broker", () => {
  // Uses the real `codex` CLI when present so verify_only probes something;
  // when absent, resolution fails and start() throws provider_cli_not_found.
  const codexPreset: ProviderPreset = {
    id: "codex",
    label: "Codex",
    command: "codex",
    description: "OpenAI Codex CLI usando a conta conectada.",
    connectionHint: "account",
    category: "account",
    docsUrl: "",
    authFlow: "device_code",
    authFlows: [
      { id: "browser", label: "browser", kind: "terminal", args: ["login"] },
      { id: "device_code", label: "device", kind: "device_code", args: ["login", "--device-auth"] },
      { id: "verify_only", label: "verify", kind: "verify_only", args: [] }
    ],
    authArgs: ["login", "--device-auth"],
    authStatusArgs: ["login", "status"]
  };

  it("resolves a verify_only flow session immediately (connected or failed)", async () => {
    const broker = new ProviderAuthBroker();
    try {
      const session = broker.start(codexPreset, "verify_only");
      // The probe resolves asynchronously; poll briefly for a terminal state.
      let current = broker.get(session.id);
      for (let i = 0; i < 40 && current?.state === "waiting"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        current = broker.get(session.id);
      }
      expect(current?.state === "connected" || current?.state === "failed").toBe(true);
    } catch (error) {
      expect((error as Error).message).toBe("provider_cli_not_found:codex");
    }
  });

  it("still rejects presets without any auth flow", () => {
    const broker = new ProviderAuthBroker();
    expect(() =>
      broker.start({ ...codexPreset, authFlow: "none", authFlows: [] })
    ).toThrow("provider_auth_flow_not_supported");
  });
});
