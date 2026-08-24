import { DashboardEvent } from "../api";
import { formatRelative, humanizeEvent } from "../helpers";
import { SectionHeader } from "./SectionHeader";
import { translate } from "../i18n";

export function EventStream({ events }: { events: DashboardEvent[] }) {
  return (
    <section className="panel event-stream" id="events" aria-labelledby="events-title">
      <SectionHeader eyebrow={translate("Telemetry")} title={translate("System pulse")} meta={translate("live")} />
      <div className="event-list">
        {events.slice(0, 12).map((event) => (
          <article className="event-row" key={event.id}>
            <span className={`event-node event-${event.source}`} />
            <div>
              <strong>{humanizeEvent(event.type)}</strong>
              <p>{event.text}</p>
            </div>
            <time dateTime={event.createdAt}>{formatRelative(event.createdAt)}</time>
          </article>
        ))}
      </div>
    </section>
  );
}
