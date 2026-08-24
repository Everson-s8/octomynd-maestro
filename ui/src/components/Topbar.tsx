import { DashboardData } from "../api";
import { formatRelative } from "../helpers";
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
        <span className="topbar-kicker">Central de operação</span>
        <h1>Bom dia.</h1>
      </div>
      <div className="topbar-actions">
        <span className="sync-stamp">
          <span className={data ? "sync-dot" : "sync-dot is-offline"} />
          {data ? `sincronizado ${formatRelative(data.generatedAt)}` : "sem conexão"}
        </span>
        <button className="icon-button" onClick={onRefresh} aria-label="Atualizar painel">
          <Icon name="refresh" className={isRefreshing ? "is-spinning" : ""} />
        </button>
        <button className="primary-action" onClick={onCreateTask}>
          <Icon name="plus" />
          Nova task
        </button>
      </div>
    </header>
  );
}
