import { describe, it, expect, vi } from "vitest";
import {
  parseWindowsNetstatOutput,
  parsePosixLsofOutput,
  findProcessOnPort,
  killProcessGracefully
} from "../src/runtime/port-process.js";

describe("parseWindowsNetstatOutput", () => {
  it("finds the PID listening on the given port", () => {
    const output = [
      "Active Connections",
      "",
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:4787           0.0.0.0:0              LISTENING       12345",
      "  TCP    127.0.0.1:5000         0.0.0.0:0              LISTENING       999"
    ].join("\r\n");
    expect(parseWindowsNetstatOutput(output, 4787)).toBe("12345");
  });

  it("ignores non-LISTENING entries", () => {
    const output = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:4787           1.2.3.4:80             ESTABLISHED     555"
    ].join("\r\n");
    expect(parseWindowsNetstatOutput(output, 4787)).toBeNull();
  });

  it("returns null when the port is not present", () => {
    const output = "  TCP    0.0.0.0:9999           0.0.0.0:0              LISTENING       1";
    expect(parseWindowsNetstatOutput(output, 4787)).toBeNull();
  });
});

describe("parsePosixLsofOutput", () => {
  it("extracts the PID from lsof output", () => {
    const output = [
      "COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "node    54321 evers   23u  IPv4 123456      0t0  TCP *:4787 (LISTEN)"
    ].join("\n");
    expect(parsePosixLsofOutput(output)).toBe("54321");
  });

  it("returns null for empty output", () => {
    expect(parsePosixLsofOutput("")).toBeNull();
  });
});

describe("findProcessOnPort", () => {
  it("uses netstat on win32", async () => {
    const runner = vi.fn(async (cmd: string, args: string[]) => {
      expect(cmd).toBe("netstat");
      expect(args).toEqual(["-ano"]);
      return {
        ok: true,
        stdout: "  TCP    0.0.0.0:4787           0.0.0.0:0              LISTENING       777",
        stderr: ""
      };
    });
    const pid = await findProcessOnPort(4787, "win32", runner);
    expect(pid).toBe("777");
  });

  it("uses lsof on posix platforms", async () => {
    const runner = vi.fn(async (cmd: string, args: string[]) => {
      expect(cmd).toBe("lsof");
      expect(args).toEqual(["-nP", "-iTCP:4787", "-sTCP:LISTEN"]);
      return {
        ok: true,
        stdout: "COMMAND PID USER\nnode 888 evers",
        stderr: ""
      };
    });
    const pid = await findProcessOnPort(4787, "linux", runner);
    expect(pid).toBe("888");
  });

  it("returns null when the lookup command fails", async () => {
    const runner = vi.fn(async () => ({ ok: false, stdout: "", stderr: "not found" }));
    const pid = await findProcessOnPort(4787, "linux", runner);
    expect(pid).toBeNull();
  });
});

describe("killProcessGracefully", () => {
  it("force-kills the full process tree on win32", async () => {
    const calls: string[][] = [];
    const runner = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { ok: true, stdout: "", stderr: "" };
    });
    // Always alive: the process lingers past the grace period, so the loop
    // deterministically escalates to the force-kill. (A mock that flips to
    // "dead" after one poll made this race the 10ms grace window and flake.)
    const isAlive = () => true;
    await killProcessGracefully("123", "win32", runner, 10, isAlive);
    expect(calls[0]).toEqual(["taskkill", "/PID", "123", "/T", "/F"]);
    expect(calls[1]).toEqual(["taskkill", "/PID", "123", "/T", "/F"]);
  });

  it("does not force-kill if the process exits before the grace period", async () => {
    const calls: string[][] = [];
    const runner = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { ok: true, stdout: "", stderr: "" };
    });
    const isAlive = () => false;
    await killProcessGracefully("123", "linux", runner, 1000, isAlive);
    expect(calls).toEqual([["kill", "-TERM", "123"]]);
  });

  it("sends SIGTERM then SIGKILL on posix when the process lingers", async () => {
    const calls: string[][] = [];
    const runner = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { ok: true, stdout: "", stderr: "" };
    });
    // Always alive: lingers past the grace period, so SIGKILL is deterministic.
    const isAlive = () => true;
    await killProcessGracefully("456", "linux", runner, 10, isAlive);
    expect(calls[0]).toEqual(["kill", "-TERM", "456"]);
    expect(calls[1]).toEqual(["kill", "-KILL", "456"]);
  });

  it("bails out when the first kill errors and the process is still alive (fail-fast)", async () => {
    const calls: string[][] = [];
    const runner = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { ok: false, stdout: "", stderr: "permission denied" };
    });
    await killProcessGracefully("789", "linux", runner, 10, () => true);
    // First kill failed AND process still alive -> return without force-killing.
    expect(calls).toEqual([["kill", "-TERM", "789"]]);
  });

  it("treats a failed first kill as fine when the process is already gone", async () => {
    const calls: string[][] = [];
    const runner = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { ok: false, stdout: "", stderr: "no such process" };
    });
    await killProcessGracefully("111", "linux", runner, 10, () => false);
    expect(calls).toEqual([["kill", "-TERM", "111"]]);
  });
});
