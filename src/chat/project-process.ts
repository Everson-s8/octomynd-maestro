import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { ChatProjectProcessFact } from "./types.js";
import type { ChatCommandPlan } from "./project-command.js";
import { redactSensitiveText, truncateForDisplay } from "../security/redaction.js";

const MAX_PROCESS_LOG = 12_000;

export type ProjectProcessManagerOptions = {
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
};

type ManagedProcess = ChatProjectProcessFact & {
  child: ChildProcess | null;
};

/** Owns long-running project commands started by Operational Chat. */
export class ProjectProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly platform: NodeJS.Platform;
  private readonly spawnProcess: typeof spawn;

  constructor(options: ProjectProcessManagerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  start(projectKey: string, projectRoot: string, plan: ChatCommandPlan): ChatProjectProcessFact {
    if (!path.isAbsolute(projectRoot)) throw new Error("A registered project is required before starting a server.");
    if (!plan.executable || plan.blockedReason) throw new Error(plan.blockedReason ?? "The project command is not executable.");

    const id = randomUUID();
    const now = new Date().toISOString();
    const record: ManagedProcess = {
      id,
      projectKey,
      command: plan.displayCommand,
      pid: null,
      status: "running",
      startedAt: now,
      endedAt: null,
      exitCode: null,
      log: "",
      url: null,
      child: null
    };
    const child = this.spawnProcess(plan.executable, plan.args, {
      cwd: projectRoot,
      shell: this.platform === "win32" && plan.executable.toLowerCase().endsWith(".cmd"),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    record.child = child;
    record.pid = child.pid ?? null;
    this.processes.set(id, record);

    const append = (chunk: Buffer | string, stream: "stdout" | "stderr") => {
      const text = redactSensitiveText(chunk.toString());
      const prefix = stream === "stderr" ? "stderr: " : "";
      record.log = truncateForDisplay(`${record.log}${prefix}${text}`, MAX_PROCESS_LOG);
      record.url = record.url ?? detectLocalUrl(record.log);
    };
    child.stdout?.on("data", (chunk) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => append(chunk, "stderr"));
    child.once("error", (error) => {
      append(error.message, "stderr");
      record.status = "failed";
      record.endedAt = new Date().toISOString();
      record.exitCode = null;
      record.child = null;
    });
    child.once("close", (code) => {
      record.status = record.status === "stopped" ? "stopped" : code === 0 ? "exited" : "failed";
      record.endedAt = new Date().toISOString();
      record.exitCode = code;
      record.child = null;
    });
    return this.snapshot(record);
  }

  list(projectKey?: string): ChatProjectProcessFact[] {
    return [...this.processes.values()]
      .filter((process) => !projectKey || process.projectKey === projectKey)
      .map((process) => this.snapshot(process));
  }

  get(id: string): ChatProjectProcessFact | null {
    const process = this.processes.get(id);
    return process ? this.snapshot(process) : null;
  }

  async waitForUrl(id: string, timeoutMs = 2_000): Promise<ChatProjectProcessFact | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = this.get(id);
      if (!current || current.url || current.status !== "running") return current;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.get(id);
  }

  stop(id: string): ChatProjectProcessFact {
    const process = this.processes.get(id);
    if (!process) throw new Error("Managed project process was not found.");
    if (!process.child || process.status !== "running") return this.snapshot(process);

    process.status = "stopped";
    if (this.platform === "win32" && process.pid) {
      this.spawnProcess("taskkill.exe", ["/PID", String(process.pid), "/T", "/F"], { windowsHide: true });
    } else if (process.pid) {
      process.child.kill("SIGTERM");
    }
    process.endedAt = new Date().toISOString();
    process.child = null;
    return this.snapshot(process);
  }

  shutdown(): void {
    for (const process of this.processes.values()) {
      if (process.status === "running") {
        try { this.stop(process.id); } catch { /* best effort during shutdown */ }
      }
    }
  }

  private snapshot(process: ManagedProcess): ChatProjectProcessFact {
    const { child: _child, ...snapshot } = process;
    return { ...snapshot, log: redactSensitiveText(snapshot.log) };
  }
}

function detectLocalUrl(log: string): string | null {
  const match = log.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s]*)?/i);
  return match?.[0]?.replace(/[),.;'\"]+$/, "") ?? null;
}
