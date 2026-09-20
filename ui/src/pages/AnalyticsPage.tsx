import { DashboardData, QuotaBucket, QuotaResult, fetchQuota } from "../api";
import { CostDisplay } from "../components/CostDisplay";
import { EventStream } from "../components/EventStream";
import { WorkGraphBoard } from "../components/WorkGraphBoard";
import { SectionHeader } from "../components/SectionHeader";
import { Icon } from "../components/Icon";
import { useEffect, useState } from "react";
import { formatNumber, translate } from "../i18n";

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
    codex: "var(--coral)",
    claude: "var(--rust)",
    antigravity: "var(--ok)",
    telegram: "var(--warn)"
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
              border: "1px solid var(--line)"
            }}
          >
            <div className="metric-icon" style={{ background: "var(--ok-bg)", color: "var(--ok)", padding: "10px", borderRadius: "8px" }}>
              <Icon name="pulse" />
            </div>
            <div>
                <span style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)", display: "block" }}>
                {translate("Completion rate")}
              </span>
              <strong style={{ fontSize: "20px", color: "var(--ivory)", fontWeight: 700 }}>
                {completionRate}% <small style={{ fontSize: "13px", color: "var(--faint)" }}>({completedCount}/{totalTasks} tasks)</small>
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
              border: "1px solid var(--line)"
            }}
          >
            <div className="metric-icon" style={{ background: "var(--warn-bg)", color: "var(--warn)", padding: "10px", borderRadius: "8px" }}>
              <Icon name="timeline" />
            </div>
            <div>
                <span style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)", display: "block" }}>
                {translate("Executed Work Graphs")}
              </span>
              <strong style={{ fontSize: "20px", color: "var(--ivory)", fontWeight: 700 }}>
                {formatNumber(data.workGraphs.length)} <small style={{ fontSize: "13px", color: "var(--faint)" }}>{translate("graphs")}</small>
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
            {providers.length === 0 ? <div style={{ color: "var(--muted)", fontSize: "13px" }}>{translate("No token measured today")}. {translate("The provider did not return input/output counters.")}</div> : providers.map((p) => {
              const total = p.inputTokens + p.outputTokens;
              const pct = Math.min(100, Math.round((total / maxProviderTokens) * 100));
              const inputPct = total > 0 ? Math.round((p.inputTokens / total) * 100) : 70;
              const color = providerColors[p.provider] || "var(--muted)";

              return (
                <div key={p.provider} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                      <span style={{ fontWeight: 600, color: "var(--ivory)", textTransform: "capitalize" }}>
                      <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", background: color, marginRight: "8px" }} />
                      {p.provider}
                    </span>
                    <span style={{ color: "var(--muted)" }}>
                      {formatNumber(total)} {translate("tokens")} ({inputPct}% {translate("input")} / {100 - inputPct}% {translate("output")})
                    </span>
                  </div>
                  <div style={{ height: "12px", background: "var(--line-soft)", borderRadius: "6px", overflow: "hidden", display: "flex" }}>
                    <div
                      style={{
                        width: `${(p.inputTokens / maxProviderTokens) * 100}%`,
                        background: color,
                        opacity: 0.9,
                        height: "100%",
                        transition: "width 0.3s ease"
                      }}
                      title={`${translate("Input")}: ${formatNumber(p.inputTokens)}`}
                    />
                    <div
                      style={{
                        width: `${(p.outputTokens / maxProviderTokens) * 100}%`,
                        background: color,
                        opacity: 0.5,
                        height: "100%",
                        transition: "width 0.3s ease"
                      }}
                      title={`${translate("Output")}: ${formatNumber(p.outputTokens)}`}
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
            {quotaLoading && <span style={{ color: "var(--muted)", fontSize: "13px" }}>{translate("Loading quotas…")}</span>}
            {!quotaLoading && quota !== null && quota.length === 0 && (
              <span style={{ color: "var(--muted)", fontSize: "13px" }}>
                {translate("No quota reading available")}. {translate("The provider may be connected without exposing a readable quota, or the required local session may be inactive.")}
              </span>
            )}
            {quota !== null &&
              quota
                .filter((q) => q.status === "ok" && q.buckets.length > 0)
                .map((q) => q.buckets.map((b) => (
                  <QuotaBar key={q.provider + (b.modelId || "")} bucket={b} color={providerColors[q.provider] || "var(--muted)"} />
                )))}
            {quota !== null &&
              quota
                .filter((q) => q.status !== "ok" || q.buckets.length === 0)
                .map((q) => (
                    <div key={q.provider} style={{ color: "var(--muted)", fontSize: "13px", textTransform: "capitalize" }}>
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
        <span style={{ fontWeight: 600, color: "var(--ivory)", textTransform: "capitalize" }}>
          <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", background: color, marginRight: "8px" }} />
          {bucket.provider}
        </span>
        <span style={{ color: "var(--muted)" }}>{label}{used != null ? ` (${used}% usado)` : ""}</span>
      </div>
      <div style={{ height: "12px", background: "var(--line-soft)", borderRadius: "6px", overflow: "hidden", display: "flex" }}>
        <div
          style={{
            width: `${barPct}%`,
            background: `linear-gradient(90deg, ${color}, var(--coral))`,
            height: "100%",
            borderRadius: "6px",
            transition: "width 0.3s ease"
          }}
        />
      </div>
      {sub && <span style={{ fontSize: "12px", color: "var(--faint)" }}>{sub}</span>}
    </div>
  );
}

function resetLabel(bucket: QuotaBucket): string | null {
  if (!bucket.resetsAt) return null;
  const diffMs = new Date(bucket.resetsAt).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return null;
  const mins = Math.max(0, Math.round(diffMs / 60_000));
  if (mins >= 60) return translate("reset in {hours}h", { hours: Math.round(mins / 60) });
  return translate("reset in {minutes}min", { minutes: mins });
}
