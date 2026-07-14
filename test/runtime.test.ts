import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rawOutputArtifactKey, recoverGoalStepRawOutput, writeGoalStepRuntimeArtifacts } from "../src/runtime/artifacts.js";
import { compressStepOutput, dedupeTokenEfficientHandoffs } from "../src/runtime/compression.js";
import { detectLocalRtk } from "../src/runtime/rtk.js";
import { estimateTokenUsage } from "../src/runtime/tokens.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-runtime-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("token estimates", () => {
  it("measures bytes and approximate tokens without external dependencies", () => {
    expect(estimateTokenUsage("")).toEqual({ bytes: 0, tokens: 0 });
    expect(estimateTokenUsage("abcd")).toEqual({ bytes: 4, tokens: 1 });
    expect(estimateTokenUsage("abcde")).toEqual({ bytes: 5, tokens: 2 });
  });
});

describe("local RTK detection", () => {
  it("detects a local RTK executable on PATH without installing anything", () => {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const executable = process.platform === "win32" ? "rtk.cmd" : "rtk";
    fs.writeFileSync(path.join(binDir, executable), "", "utf8");

    const detection = detectLocalRtk({
      PATH: binDir,
      PATHEXT: ".CMD;.EXE"
    });

    expect(detection.available).toBe(true);
    expect(detection.source).toBe("path");
    expect(detection.command).toContain("rtk");
  });

  it("detects an npm-global RTK JavaScript entry and uses node to execute it", () => {
    const packageDir = path.join(tempDir, "npm", "node_modules", "rtk", "bin");
    fs.mkdirSync(packageDir, { recursive: true });
    const cli = path.join(packageDir, "rtk.js");
    fs.writeFileSync(cli, "console.log('rtk')", "utf8");

    const detection = detectLocalRtk({
      PATH: "",
      APPDATA: tempDir
    });

    expect(detection.available).toBe(true);
    expect(detection.source).toBe("npm_global");
    expect(detection.command).toBe(process.execPath);
    expect(detection.argsPrefix).toEqual([cli]);
  });

  it("falls back transparently when RTK is absent", () => {
    const detection = detectLocalRtk({ PATH: "" });

    expect(detection.available).toBe(false);
    expect(detection.source).toBe("absent");
    expect(detection.detail).toContain("compressor interno");
  });
});

describe("output compression", () => {
  it("keeps only the latest equivalent handoff", () => {
    const base = compressStepOutput({
      step: {
        id: 1,
        phase: "testing",
        provider: "codex",
        status: "failed",
        summary: "same failure",
        output: "FAIL same test",
        error: "same failure"
      },
      rtk: detectLocalRtk({ PATH: "" })
    }).handoff;
    const latest = { ...base, stepId: 2, provider: "claude" };

    const result = dedupeTokenEfficientHandoffs([base, latest]);

    expect(result.removed).toBe(1);
    expect(result.steps).toEqual([latest]);
  });

  it("keeps errors and relevant evidence while reducing the handoff payload", () => {
    const fakeSecret = `${["sk", "proj"].join("-")}-${"a".repeat(24)}`;
    const noisyOutput = [
      "git diff -- src/runtime/compression.ts",
      "diff --git a/src/runtime/compression.ts b/src/runtime/compression.ts",
      "@@ -1,3 +1,5 @@",
      `+const leaked = "${fakeSecret}";`,
      "npm test",
      "FAIL test/runtime.test.ts > preserves evidence",
      "AssertionError: expected compact output to include evidence",
      "FINAL_REVIEW_DECISION: changes_requested",
      "noise ".repeat(1_000)
    ].join("\n");

    const result = compressStepOutput({
      step: {
        id: 3,
        phase: "testing",
        provider: "codex",
        status: "failed",
        summary: "tests failed",
        output: noisyOutput,
        error: "AssertionError: expected compact output to include evidence"
      },
      rtk: detectLocalRtk({ PATH: "" }),
      rawOutputArtifact: "goal-1/step-0003-testing-codex/provider-output.raw.txt"
    });

    expect(result.compactOutput).toContain("AssertionError");
    expect(result.compactOutput).toContain("FINAL_REVIEW_DECISION: changes_requested");
    expect(result.compactOutput).toContain("[REDACTED_SECRET]");
    expect(result.compactOutput).not.toContain(fakeSecret);
    expect(result.telemetry.commands.map((item) => item.command)).toEqual(expect.arrayContaining(["git.diff", "test"]));
    expect(result.telemetry.baseline.bytes).toBeGreaterThan(result.telemetry.compact.bytes);
    expect(result.telemetry.abTest.savedTokens).toBeGreaterThan(0);
    expect(result.telemetry.abTest.quality.failureOutputPreserved).toBe(true);
  });

  it("writes sanitized raw output, compact handoff and telemetry artifacts for on-demand recovery", () => {
    const step = {
      id: 9,
      runId: 2,
      phase: "testing" as const,
      provider: "codex"
    };
    const compression = compressStepOutput({
      step: {
        ...step,
        status: "completed",
        summary: "tests passed",
        output: "PASS test/runtime.test.ts\nTest Files 1 passed",
        error: null
      },
      rtk: detectLocalRtk({ PATH: "" }),
      rawOutputArtifact: rawOutputArtifactKey(step)
    });

    const keys = writeGoalStepRuntimeArtifacts({
      artifactsRoot: tempDir,
      step,
      rawOutput: "PASS test/runtime.test.ts\nTest Files 1 passed",
      compactHandoff: compression.compactOutput,
      telemetry: compression.telemetry
    });

    expect(keys.rawOutputKey).toBe(rawOutputArtifactKey(step));
    expect(recoverGoalStepRawOutput(tempDir, step)).toContain("PASS test/runtime.test.ts");
    expect(fs.existsSync(path.join(tempDir, ...keys.compactHandoffKey.split("/")))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, ...keys.telemetryKey.split("/")))).toBe(true);
  });
});
