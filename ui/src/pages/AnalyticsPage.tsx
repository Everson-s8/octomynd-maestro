import { DashboardData, QuotaBucket, QuotaResult, fetchQuota } from "../api";
import { CostDisplay } from "../components/CostDisplay";
import { EventStream } from "../components/EventStream";
import { WorkGraphBoard } from "../components/WorkGraphBoard";
import { SectionHeader } from "../components/SectionHeader";
import { Icon } from "../components/Icon";
import { useEffect, useState } from "react";
import { translate } from "../i18n";

export interface AnalyticsPageProps {
  data: DashboardData;
  onRefresh: () => Promise<unknown>;
}

export function AnalyticsPage({ data, onRefresh }: AnalyticsPageProps) {
  const [quota, setQuota] = useState<QuotaResult[] | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setQuotaLoading(true);
    fetchQuota()
      .then((q) => { if (!cancelled) setQuota(q); })
      .catch(() => { if (!cancelled) setQuota([]); })
      .finally(() => { if (!cancelled) setQuotaLoading(false); });
    return () => { cancelled = true; };
  }, [onRefresh]);

  const completedCount = data.tasks.filter((t) => t.status === "done").length;
  const totalTasks = data.tasks.length;
  const completionRate = totalTasks > 0 ? Math.round((completedCount / totalTasks) * 100) : 100;

  const costSummary = data.costSummary ?? { todayTotalUsd: 0, todayInputTokens: 0, todayOutputTokens: 0, byProvider: [], byProject: [] };
  const costToday = costSummary.todayTotalUsd;
  const totalTokens = costSummary.todayInputTokens + costSummary.todayOutputTokens;
  const providers = costSummary.byProvider.filter((provider) => provider.inputTokens + provider.outputTokens > 0);

  const maxProviderTokens = Math.max(1, ...providers.map((p) => p.inputTokens + p.outputTokens));

  const providerColors: Record<string, string> = {
    codex: "#38bdf8",
    claude: "#a855f7",
    antigravity: "#34d399",
    telegram: "#f59e0b"
  };

  return (
    <div className="analytics-page-grid" style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div className="panel analytics-overview" style={{ padding: "20px" }}>
        <SectionHeader eyebrow={translate("Telemetry & costs")} title={translate("Analytics & operational metrics")} meta={translate("Real-time metrics")} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px", marginTop: "20px" }}>
          <CostDisplay costToday={costToday} estimatedTokens={totalTokens} measured />

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
                {translate("Completion rate")}
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

        {/* Economics and charts section */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: "20px" }}>
        {/* Token usage chart */}
        <div className="panel token-chart-panel" style={{ padding: "20px" }}>
          <SectionHeader eyebrow={translate("Token consumption")} title={translate("Token Usage Chart")} meta={translate("Input vs output tokens by provider")} />
          <div style={{ marginTop: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
            {providers.length === 0 ? <div style={{ color: "#64748b", fontSize: "13px" }}>{translate("No token measured today")}. {translate("The provider did not return input/output counters.")}</div> : providers.map((p) => {
              const total = p.inputTokens + p.outputTokens;
              const pct = Math.min(100, Math.round((total / maxProviderTokens) * 100));
              const inputPct = total > 0 ? Math.round((p.inputTokens / total) * 100) : 70;
              const color = providerColors[p.provider] || "#a0a5b5";

              return (
                <div key={p.provider} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                    <span style={{ fontWeight: 600, color: "#e2e8f0", textTransform: "capitalize" }}>
                      <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", background: color, marginRight: "8px" }} />
                      {p.provider}
                    </span>
                    <span style={{ color: "#94a3b8" }}>
                      {total.toLocaleString()} tokens ({inputPct}% in / {100 - inputPct}% out)
                    </span>
                  </div>
                  <div style={{ height: "12px", background: "rgba(255,255,255,0.06)", borderRadius: "6px", overflow: "hidden", display: "flex" }}>
                    <div
                      style={{
                        width: `${(p.inputTokens / maxProviderTokens) * 100}%`,
                        background: color,
                        opacity: 0.9,
                        height: "100%",
                        transition: "width 0.3s ease"
                      }}
                      title={`Input: ${p.inputTokens.toLocaleString()}`}
                    />
                    <div
                      style={{
                        width: `${(p.outputTokens / maxProviderTokens) * 100}%`,
                        background: color,
                        opacity: 0.5,
                        height: "100%",
                        transition: "width 0.3s ease"
                      }}
                      title={`Output: ${p.outputTokens.toLocaleString()}`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Available quota per provider */}
        <div className="panel cost-chart-panel" style={{ padding: "20px" }}>
          <SectionHeader eyebrow={translate("Available quota")} title={translate("Quota Usage Chart")} meta={translate("Remaining quota percentage and next reset by provider")} />
          <div style={{ marginTop: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
            {quotaLoading && <span style={{ color: "#94a3b8", fontSize: "13px" }}>{translate("Loading quotas…")}</span>}
            {!quotaLoading && quota !== null && quota.length === 0 && (
              <span style={{ color: "#64748b", fontSize: "13px" }}>
                {translate("No quota reading available")}. {translate("The provider may be connected without exposing a readable quota, or the required local session may be inactive.")}
              </span>
            )}
            {quota !== null &&
              quota
                .filter((q) => q.status === "ok" && q.buckets.length > 0)
                .map((q) => q.buckets.map((b) => (
                  <QuotaBar key={q.provider + (b.modelId || "")} bucket={b} color={providerColors[q.provider] || "#a0a5b5"} />
                )))}
            {quota !== null &&
              quota
                .filter((q) => q.status !== "ok" || q.buckets.length === 0)
                .map((q) => (
                  <div key={q.provider} style={{ color: "#64748b", fontSize: "13px", textTransform: "capitalize" }}>
                    {q.provider}: {q.error || translate("unavailable")}
                  </div>
                ))}
          </div>
        </div>
      </div>

      <WorkGraphBoard workGraphs={data.workGraphs} onChanged={onRefresh} />

      <EventStream events={data.events} />
    </div>
  );
}

// Renders the available quota bar for one quota bucket (provider/model).
function QuotaBar({ bucket, color }: { bucket: QuotaBucket; color: string }) {
  const remaining = bucket.remainingPercent;
  const used = bucket.usedPercent;
  // Show the remaining fraction as the filled bar.
  const barPct = remaining == null ? 0 : Math.max(0, Math.min(100, remaining));
  const label = remaining == null ? "n/d" : `${remaining}% restante`;
  const sub = [
    bucket.planType ? bucket.planType : null,
    bucket.detail ? bucket.detail : null,
    bucket.modelId ? `modelo ${bucket.modelId}` : null,
    resetLabel(bucket)
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
        <span style={{ fontWeight: 600, color: "#e2e8f0", textTransform: "capitalize" }}>
          <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", background: color, marginRight: "8px" }} />
          {bucket.provider}
        </span>
        <span style={{ color: "#94a3b8" }}>{label}{used != null ? ` (${used}% usado)` : ""}</span>
      </div>
      <div style={{ height: "12px", background: "rgba(255,255,255,0.06)", borderRadius: "6px", overflow: "hidden", display: "flex" }}>
        <div
          style={{
            width: `${barPct}%`,
            background: `linear-gradient(90deg, ${color}, #38bdf8)`,
            height: "100%",
            borderRadius: "6px",
            transition: "width 0.3s ease"
          }}
        />
      </div>
      {sub && <span style={{ fontSize: "12px", color: "#64748b" }}>{sub}</span>}
    </div>
  );
}

function resetLabel(bucket: QuotaBucket): string | null {
  if (!bucket.resetsAt) return null;
  const diffMs = new Date(bucket.resetsAt).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return null;
  const mins = Math.max(0, Math.round(diffMs / 60_000));
  if (mins >= 60) return `reset em ${Math.round(mins / 60)}h`;
  return `reset em ${mins}min`;
}
