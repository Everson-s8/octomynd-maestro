import { DashboardData } from "../api";
import { calculateDashboardCost, CostDisplay } from "../components/CostDisplay";
import { EventStream } from "../components/EventStream";
import { WorkGraphBoard } from "../components/WorkGraphBoard";
import { SectionHeader } from "../components/SectionHeader";
import { Icon } from "../components/Icon";

export interface AnalyticsPageProps {
  data: DashboardData;
  onRefresh: () => Promise<unknown>;
}

export function AnalyticsPage({ data, onRefresh }: AnalyticsPageProps) {
  const { costToday, totalTokens } = calculateDashboardCost(data.workGraphs);

  const completedCount = data.tasks.filter((t) => t.status === "done").length;
  const totalTasks = data.tasks.length;
  const completionRate = totalTasks > 0 ? Math.round((completedCount / totalTasks) * 100) : 100;

  return (
    <div className="analytics-page-grid" style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div className="panel analytics-overview" style={{ padding: "20px" }}>
        <SectionHeader eyebrow="Telemetria & Custos" title="Analytics & Métricas Operacionais" meta="Métricas em tempo real" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px", marginTop: "20px" }}>
          <CostDisplay costToday={costToday} estimatedTokens={totalTokens} />

          <div
            className="metric-card tone-lime"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "16px",
              padding: "16px",
              borderRadius: "10px",
              background: "rgba(255,255,255,0.03)",
              border: "1px solid #2e323e"
            }}
          >
            <div className="metric-icon" style={{ background: "rgba(132, 204, 22, 0.15)", color: "#84cc16", padding: "10px", borderRadius: "8px" }}>
              <Icon name="pulse" />
            </div>
            <div>
              <span style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.05em", color: "#a0a5b5", display: "block" }}>
                Taxa de Conclusão (Completion Rate)
              </span>
              <strong style={{ fontSize: "20px", color: "#ffffff", fontWeight: 700 }}>
                {completionRate}% <small style={{ fontSize: "13px", color: "#808595" }}>({completedCount}/{totalTasks} tasks)</small>
              </strong>
            </div>
          </div>

          <div
            className="metric-card tone-pink"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "16px",
              padding: "16px",
              borderRadius: "10px",
              background: "rgba(255,255,255,0.03)",
              border: "1px solid #2e323e"
            }}
          >
            <div className="metric-icon" style={{ background: "rgba(236, 72, 153, 0.15)", color: "#ec4899", padding: "10px", borderRadius: "8px" }}>
              <Icon name="timeline" />
            </div>
            <div>
              <span style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.05em", color: "#a0a5b5", display: "block" }}>
                Work Graphs Executados
              </span>
              <strong style={{ fontSize: "20px", color: "#ffffff", fontWeight: 700 }}>
                {data.workGraphs.length} <small style={{ fontSize: "13px", color: "#808595" }}>graphs</small>
              </strong>
            </div>
          </div>
        </div>
      </div>

      <WorkGraphBoard workGraphs={data.workGraphs} onChanged={onRefresh} />

      <EventStream events={data.events} />
    </div>
  );
}
