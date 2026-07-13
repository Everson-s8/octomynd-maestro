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
  private readonly pending = new Map<number, () => void>();

  schedule(callback: () => void, _delayMs: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, callback);
    return id;
  }

  cancel(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  flush(): void {
    const callbacks = Array.from(this.pending.values());
    this.pending.clear();
    for (const callback of callbacks) callback();
  }
}
