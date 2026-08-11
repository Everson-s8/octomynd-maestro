import { DashboardEvent } from "../api";
import { formatRelative, humanizeEvent } from "../helpers";
import { SectionHeader } from "./SectionHeader";

export function EventStream({ events }: { events: DashboardEvent[] }) {
  return (
    <section className="panel event-stream" id="events" aria-labelledby="events-title">
      <SectionHeader eyebrow="Telemetria" title="Pulso do sistema" meta="ao vivo" />
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
