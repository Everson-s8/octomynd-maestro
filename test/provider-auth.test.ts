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
});
