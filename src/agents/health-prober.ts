import { AgentHealth } from "./types.js";

export type HealthProberLike = {
  /** Current cached health; may be stale or null before the first probe. */
  health(): Promise<AgentHealth>;
};

/**
 * F5: background health prober.
 *
 * The dashboard request path used to call provider.health() directly, and a
 * cache miss ran spawnSync probes (up to 10s each on cold Windows shims)
 * inside the HTTP handler — freezing every poll while CLIs were checked.
 *
 * This prober owns the probing loop instead: each tick refreshes ALL
 * providers in parallel, off the request path, and stores the latest result.
 * Request handlers just read the last-known-good snapshot — never probe, never
 * block. A provider that has never been probed reports state "offline" with an
 * explicit "checking" detail so the UI shows an honest pending state for at
 * most one poll interval after boot.
 */
export class BackgroundHealthProber {
  private readonly latest = new Map<string, AgentHealth>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private startedAt = Date.now();

  constructor(
    private readonly providers: Map<string, HealthProberLike>,
    private readonly intervalMs = 20_000
  ) {}

  setProvider(providerId: string, provider: HealthProberLike): void {
    this.providers.set(providerId, provider);
    this.latest.delete(providerId);
    if (this.timer) void this.tick();
  }

  removeProvider(providerId: string): void {
    this.providers.delete(providerId);
    this.latest.delete(providerId);
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Last-known-good health without any I/O. Never blocks. */
  peek(providerId: string): AgentHealth {
    const cached = this.latest.get(providerId);
    if (cached) return cached;
    return {
      state: "offline",
      // Honest boot-time placeholder; replaced within one interval.
      detail: "Verificando disponibilidade do CLI...",
      checkedAt: new Date().toISOString()
    };
  }

  async refreshNow(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await Promise.all(
        [...this.providers.entries()].map(async ([id, provider]) => {
          try {
            this.latest.set(id, await provider.health());
          } catch {
            this.latest.set(id, {
              state: "offline",
              detail: "Falha ao verificar o CLI do provider.",
              checkedAt: new Date().toISOString()
            });
          }
        })
      );
    } finally {
      this.ticking = false;
    }
  }
}
