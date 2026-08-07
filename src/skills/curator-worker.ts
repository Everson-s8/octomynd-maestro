import type { MaestroDatabase } from "../db.js";
import { SkillCurator } from "./curator.js";

export type SkillCuratorWorkerOptions = {
  pollIntervalMs?: number;
};

const MIN_POLL_INTERVAL_MS = 60_000;
const MAX_POLL_INTERVAL_MS = 24 * 60 * 60_000;

export class SkillCuratorWorker {
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly database: MaestroDatabase,
    private readonly curator: SkillCurator,
    options: SkillCuratorWorkerOptions = {}
  ) {
    this.pollIntervalMs = boundedInteger(options.pollIntervalMs, 6 * 60 * 60_000);
  }

  start(): void {
    if (this.timer) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reconcile(): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const { archived } = this.curator.applyAutomaticArchival();
      if (archived.length > 0) {
        this.database.addEvent({
          source: "maestro",
          type: "skill.curator_worker_applied",
          text: `${archived.length} agent-owned Skill(s) auto-archived by the Curator.`,
          metadata: { archived }
        });
      }
      return archived;
    } finally {
      this.running = false;
    }
  }
}

function boundedInteger(value: number | undefined, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, value as number));
}
