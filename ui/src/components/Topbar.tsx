import { DashboardData } from "../api";
import { formatRelative } from "../helpers";
import { translate } from "../i18n";
import { Icon } from "./Icon";

export function Topbar({
  data,
  isRefreshing,
  onRefresh,
  onCreateTask
}: {
  data: DashboardData | null;
  isRefreshing: boolean;
  onRefresh: () => void;
  onCreateTask: () => void;
}) {
  return (
    <header className="topbar">
      <div>
        <span className="topbar-kicker">{translate("Operation center")}</span>
        <h1>{translate("Good morning.")}</h1>
      </div>
      <div className="topbar-actions">
        <span className="sync-stamp">
          <span className={data ? "sync-dot" : "sync-dot is-offline"} />
          {data ? `${translate("Synced now")} ${formatRelative(data.generatedAt)}` : translate("Offline")}
        </span>
        <button className="icon-button" onClick={onRefresh} aria-label={translate("Refresh dashboard")}>
          <Icon name="refresh" className={isRefreshing ? "is-spinning" : ""} />
        </button>
        <button className="primary-action" onClick={onCreateTask}>
          <Icon name="plus" />
          {translate("+ New task")}
        </button>
      </div>
    </header>
  );
}
