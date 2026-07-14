import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessExecutionPaths,
  captureEnvironmentFingerprint,
  ensureExecutionContract,
  isPathWithin,
  isSupportedNodeVersion,
  resolveExecutionContract
} from "../src/execution/contract.js";

describe("execution contract", () => {
  it("uses a dedicated Windows runtime root for new worktrees", () => {
    const contract = resolveExecutionContract("C:\\repo", "Octomynd Maestro", {
      SystemDrive: "D:"
    }, "win32");

    expect(contract.rootPath).toBe(path.win32.resolve("D:\\MaestroRuntime\\octomynd-maestro"));
    expect(contract.worktreesPath).toBe(path.win32.join(contract.rootPath, "worktrees"));
  });

  it("rejects profile, cloud-synced and detached worktree roots", () => {
    const assessment = assessExecutionPaths({
      rootPath: "C:\\Users\\everson\\OneDrive\\MaestroRuntime",
      worktreesPath: "D:\\other\\worktrees"
    }, { USERPROFILE: "C:\\Users\\everson" });

    expect(assessment.ready).toBe(false);
    expect(assessment.underUserProfile).toBe(true);
    expect(assessment.cloudSynced).toBe(true);
    expect(assessment.reasons).toHaveLength(3);
  });

  it("accepts the pinned Node patch line and rejects divergent majors/minors", () => {
    expect(isSupportedNodeVersion("v20.17.0")).toBe(true);
    expect(isSupportedNodeVersion("20.17.5")).toBe(true);
    expect(isSupportedNodeVersion("v20.16.9")).toBe(false);
    expect(isSupportedNodeVersion("v24.0.0")).toBe(false);
  });

  it("preserves path privacy in the environment fingerprint", () => {
    const contract = resolveExecutionContract("C:\\repo", "Maestro", {
      SystemDrive: "C:",
      USERPROFILE: "C:\\Users\\everson",
      PATH: process.env.PATH
    }, "win32");
    const fingerprint = captureEnvironmentFingerprint(contract, {
      USERPROFILE: "C:\\Users\\everson",
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT
    });
    const serialized = JSON.stringify(fingerprint);

    expect(fingerprint.id).toHaveLength(16);
    expect(fingerprint.tools.find((tool) => tool.name === "npm")?.available).toBe(true);
    expect(fingerprint.tools.find((tool) => tool.name === "git")?.available).toBe(true);
    expect(serialized).not.toContain("C:\\Users\\everson");
    expect(serialized).not.toContain(contract.rootPath);
  });

  it("compares paths without prefix collisions", () => {
    expect(isPathWithin("C:\\MaestroRuntime\\worktrees", "C:\\MaestroRuntime")).toBe(true);
    expect(isPathWithin("C:\\MaestroRuntime-old", "C:\\MaestroRuntime")).toBe(false);
  });

  it("creates an idempotent marker without storing host paths", () => {
    const rootPath = process.platform === "win32"
      ? path.join(path.parse(process.cwd()).root, "MaestroRuntime", `.test-${process.pid}`)
      : path.join(process.cwd(), ".tmp-execution-contract-test");
    const contract = {
      rootPath,
      worktreesPath: path.join(rootPath, "worktrees"),
      expectedNodeVersion: "20.17.0",
      supportedNodeRange: ">=20.17.0 <21"
    };
    try {
      const first = ensureExecutionContract(contract);
      const second = ensureExecutionContract(contract);
      const marker = JSON.parse(
        fs.readFileSync(path.join(rootPath, ".maestro-execution.json"), "utf8")
      ) as Record<string, unknown>;

      expect(first).toEqual(second);
      expect(marker).toEqual(first);
      expect(JSON.stringify(marker)).not.toContain(rootPath);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });
});
