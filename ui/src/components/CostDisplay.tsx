import { DashboardData, DashboardWorkGraph } from "../api";
import { translate } from "../i18n";
import { Icon } from "./Icon";

export function CostDisplay({
  costToday = 0,
  estimatedTokens = 0,
  measured = false,
  currency = "$"
}: {
  costToday?: number;
  estimatedTokens?: number;
  measured?: boolean;
  currency?: string;
}) {
  const hasUsage = costToday > 0 || estimatedTokens > 0;
  const formattedCost = `${currency}${costToday.toFixed(2)}`;
  const formattedTokens = estimatedTokens > 1000000
    ? `${(estimatedTokens / 1000000).toFixed(1)}M`
    : estimatedTokens > 1000
    ? `${(estimatedTokens / 1000).toFixed(1)}k`
    : `${estimatedTokens}`;

  return (
    <div className="cost-display-card">
      <div className="metric-icon cost-display-icon">
        <Icon name="dollar" />
      </div>
      <div>
        <span className="analytics-kicker">{measured ? translate("Recorded usage today") : translate("Cost today / tokens")}</span>
        <strong className="analytics-value">
          {measured && !hasUsage ? translate("Not reported") : <>{formattedCost} <small className="analytics-subtle">({formattedTokens} tokens)</small></>}
        </strong>
        {measured && !hasUsage ? <small className="analytics-subtle analytics-note">{translate("The provider did not return usage metrics.")}</small> : null}
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
