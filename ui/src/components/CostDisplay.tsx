import { DashboardData, DashboardWorkGraph } from "../api";
import { Icon } from "./Icon";

export function CostDisplay({
  costToday = 0,
  estimatedTokens = 0,
  currency = "$"
}: {
  costToday?: number;
  estimatedTokens?: number;
  currency?: string;
}) {
  const formattedCost = `${currency}${costToday.toFixed(2)}`;
  const formattedTokens = estimatedTokens > 1000000
    ? `${(estimatedTokens / 1000000).toFixed(1)}M`
    : estimatedTokens > 1000
    ? `${(estimatedTokens / 1000).toFixed(1)}k`
    : `${estimatedTokens}`;

  return (
    <div className="cost-display-card" style={{ display: "flex", gap: "16px", alignItems: "center", background: "rgba(255,255,255,0.03)", padding: "16px", borderRadius: "10px", border: "1px solid var(--border-color, #2e323e)" }}>
      <div className="metric-icon" style={{ background: "rgba(56, 189, 248, 0.15)", color: "#38bdf8", padding: "10px", borderRadius: "8px", display: "flex" }}>
        <Icon name="dollar" />
      </div>
      <div>
        <span style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.05em", color: "#a0a5b5", display: "block" }}>Custo Hoje / Tokens</span>
        <strong style={{ fontSize: "20px", color: "#ffffff", fontWeight: 700 }}>
          {formattedCost} <small style={{ fontSize: "13px", color: "#808595", fontWeight: 500 }}>({formattedTokens} tokens)</small>
        </strong>
      </div>
    </div>
  );
}

export function calculateDashboardCost(
  data?: Partial<DashboardData> | DashboardWorkGraph[]
): { costToday: number; totalTokens: number } {
  if (Array.isArray(data)) {
    let totalTokens = 0;
    for (const graph of data) {
      totalTokens += graph.canary?.estimatedTokens ?? 0;
    }
    const costToday = (totalTokens / 1000) * 0.002;
    return { costToday, totalTokens };
  }

  if (data?.costSummary) {
    const costToday = data.costSummary.todayTotalUsd ?? 0;
    const totalTokens = (data.costSummary.todayInputTokens ?? 0) + (data.costSummary.todayOutputTokens ?? 0);
    if (costToday > 0 || totalTokens > 0) {
      return { costToday, totalTokens };
    }
  }

  let totalTokens = 0;
  if (data?.workGraphs) {
    for (const graph of data.workGraphs) {
      totalTokens += graph.canary?.estimatedTokens ?? 0;
    }
  }
  const costToday = (totalTokens / 1000) * 0.002;
  return { costToday, totalTokens };
}
