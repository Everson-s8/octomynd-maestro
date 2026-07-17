export interface Scheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export class SystemScheduler implements Scheduler {
  schedule(callback: () => void, delayMs: number): unknown {
    return setTimeout(callback, delayMs);
  }

  cancel(handle: unknown): void {
    clearTimeout(handle as NodeJS.Timeout);
  }
}

/**
 * Deterministic scheduler for tests: `schedule` never fires on its own,
 * callers advance time explicitly via `flush()`.
 */
export class ManualScheduler implements Scheduler {
  private nextId = 1;
  private readonly pending = new Map<number, { callback: () => void; delayMs: number }>();

  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { callback, delayMs });
    return id;
  }

  cancel(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get pendingDelaysMs(): number[] {
    return [...this.pending.values()].map((item) => item.delayMs);
  }

  flush(): void {
    const callbacks = Array.from(this.pending.values()).map((item) => item.callback);
    this.pending.clear();
    for (const callback of callbacks) callback();
  }
}
