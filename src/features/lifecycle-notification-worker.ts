import type { EventRecord, MaestroDatabase } from "../db.js";
import type {
  FeaturePlanLifecycleEvent,
  FeaturePlanLifecycleNotificationHandler
} from "../telegram/notifications.js";

const INITIALIZED_EVENT = "feature_plan.lifecycle_worker_initialized";
const SENT_EVENT = "feature_plan.lifecycle_notification_sent";
const FAILED_EVENT = "feature_plan.lifecycle_notification_failed";

export class FeaturePlanLifecycleNotificationWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly database: MaestroDatabase,
    private readonly notify?: FeaturePlanLifecycleNotificationHandler,
    private readonly pollIntervalMs = 5_000
  ) {}

  start(): void {
    if (this.timer || !this.notify) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reconcile(): Promise<number> {
    if (this.running || !this.notify) return 0;
    this.running = true;
    try {
      const initialized = this.database.findLatestEventByType(INITIALIZED_EVENT);
      if (!initialized) {
        const latestId = this.database.getLastEvent()?.id ?? 0;
        this.database.addEvent({
          source: "maestro",
          type: INITIALIZED_EVENT,
          text: "Feature Plan lifecycle notification worker initialized.",
          metadata: { cursor: latestId }
        });
        return 0;
      }

      let cursor = Math.max(initialized.id, Number(initialized.metadata.cursor ?? 0));
      let delivered = 0;
      const events = this.database.listEventsAfter(cursor, 100);
      for (const source of events) {
        cursor = source.id;
        const lifecycle = this.toLifecycleEvent(source);
        if (!lifecycle || this.database.hasEventForSource(SENT_EVENT, source.id)) continue;
        try {
          await this.notify({ ...lifecycle, sourceEventId: source.id });
          delivered += 1;
        } catch (error) {
          this.database.addEvent({
            source: "maestro",
            type: FAILED_EVENT,
            text: error instanceof Error ? error.message : "Feature Plan lifecycle notification failed.",
            metadata: { sourceEventId: source.id, featurePlanId: lifecycle.plan.id }
          });
          return delivered;
        }
      }
      if (events.length > 0) {
        this.database.addEvent({
          source: "maestro",
          type: INITIALIZED_EVENT,
          text: "Feature Plan lifecycle notification cursor advanced.",
          metadata: { cursor }
        });
      }
      return delivered;
    } finally {
      this.running = false;
    }
  }

  private toLifecycleEvent(source: EventRecord): Omit<FeaturePlanLifecycleEvent, "sourceEventId"> | null {
    const featurePlanId = Number(source.metadata.featurePlanId ?? 0);
    if (!Number.isInteger(featurePlanId) || featurePlanId <= 0) return null;

    const directActions: Record<string, FeaturePlanLifecycleEvent["action"]> = {
      "feature_plan.admitted": "admitted",
      "feature_plan.paused": "paused",
      "feature_plan.resumed": "resumed",
      "feature_plan.retried": "retried",
      "feature_plan.cancelled": "cancelled",
      "feature_plan.priority_updated": "priority_updated"
    };
    let action = directActions[source.type];
    if (!action && source.type === "feature_plan.status_changed") {
      const status = String(source.metadata.status ?? "");
      if (status === "blocked") action = "blocked";
      if (status === "cancelled") action = "cancelled";
    }
    if (!action) return null;

    return {
      plan: this.database.getFeaturePlan(featurePlanId),
      action,
      reason: typeof source.metadata.reason === "string" ? source.metadata.reason : source.text
    };
  }
}
