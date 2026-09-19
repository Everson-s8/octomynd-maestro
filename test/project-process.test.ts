import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectProcessManager } from "../src/chat/project-process.js";
import { planProjectStartCommand } from "../src/chat/project-command.js";

describe("managed project processes", () => {
  let manager: ProjectProcessManager | undefined;
  let projectRoot: string | undefined;

  afterEach(async () => {
    manager?.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (projectRoot) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
          break;
        } catch (error) {
          if (!(error instanceof Error) || !/EBUSY|EPERM/i.test(error.message) || attempt === 9) throw error;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    }
  });

  it("starts, lists, exposes logs, and stops a long-running project command", async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-project-process-"));
    fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "managed-project",
      version: "1.0.0",
      scripts: { dev: "node -e \"console.log('server ready'); setInterval(() => {}, 1000)\"" }
    }), "utf8");
    manager = new ProjectProcessManager();

    const plan = planProjectStartCommand(projectRoot, "full");
    const started = manager.start("demo", projectRoot, plan);
    expect(started.status).toBe("running");
    expect(started.pid).toBeTypeOf("number");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (manager.list("demo")[0]?.log.includes("server ready")) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const listed = manager.list("demo");
    expect(listed).toHaveLength(1);
    expect(listed[0].pid).toBe(started.pid);
    expect(listed[0].log).toContain("server ready");

    const stopped = manager.stop(started.id);
    expect(stopped.status).toBe("stopped");
    expect(stopped.endedAt).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  });
});
