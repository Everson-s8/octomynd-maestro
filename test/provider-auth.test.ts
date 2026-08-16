import { describe, expect, it } from "vitest";

import { parseDeviceAuthorization } from "../src/agents/provider-auth.js";

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
