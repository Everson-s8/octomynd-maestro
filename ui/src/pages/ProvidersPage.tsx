import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DashboardData,
  fetchProviderPolicy,
  ProviderPolicySnapshot,
  ProviderRescanEntry,
  refreshProviders,
  rescanProviders
} from "../api";
import { AgentDock } from "../components/AgentDock";
import { ProviderManager } from "../components/ProviderManager";
import { translate } from "../i18n";

export interface ProvidersPageProps {
  data: DashboardData;
  onRefresh?: () => void | Promise<void>;
}

export function ProvidersPage({ data, onRefresh }: ProvidersPageProps) {
  const [policy, setPolicy] = useState<ProviderPolicySnapshot | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanSummary, setScanSummary] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState("");

  const refreshPolicy = useCallback(async () => {
    try {
      setPolicy(await fetchProviderPolicy());
    } catch {
      // Keep the last known policy during a transient dashboard refresh.
    }
  }, []);

  useEffect(() => {
    void refreshPolicy();
  }, [refreshPolicy]);

  const ready = useMemo(
    () => data.agents.filter((agent) => agent.id !== "telegram" && (agent.state === "ready" || agent.state === "working")),
    [data.agents]
  );
  const installed = useMemo(
    () => data.agents.filter((agent) => agent.id !== "telegram" && agent.state !== "offline"),
    [data.agents]
  );

  const summarizeScan = (providers: ProviderRescanEntry[]) => {
    const installed = providers.filter((provider) => provider.installed);
    const authenticated = installed.filter((provider) => provider.authStatus === "authenticated");
    return translate("Provider scan: {installed} CLI(s) installed · {authenticated} authenticated session(s)", {
      installed: installed.length,
      authenticated: authenticated.length
    }) +
      (installed.length ? ` · ${installed.map((provider) => provider.label).join(", ")}` : "");
  };

  const handleRescan = useCallback(async () => {
    setScanning(true);
    setScanSummary(null);
    setRefreshError("");
    try {
      // Cache invalidation is best effort. The actual rescan below is the
      // authoritative operation and must still run in dashboard-only builds.
      try {
        await refreshProviders();
      } catch {
        // Continue: rescanProviders can still refresh PATH/auth state.
      }
      const result = await rescanProviders();
      setScanSummary(summarizeScan(result.providers));
      await onRefresh?.();
      await refreshPolicy();
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : translate("Unable to rescan providers."));
    } finally {
      setScanning(false);
    }
  }, [onRefresh, refreshPolicy]);

  return (
    <div className="providers-page">
      <div className="top">
        <div>
          <div className="eyebrow">{translate("AI Routing")}</div>
          <h1>{translate("Providers")}</h1>
        </div>
        <div className="top-actions">
          <span className="provider-summary">{translate("{installed} CLI(s) detected · {ready} ready for use", { installed: installed.length, ready: ready.length })}</span>
          <button type="button" className="btn-ghost" onClick={() => void handleRescan()} disabled={scanning}>
            {scanning ? translate("Rescanning…") : translate("Refresh providers")}
          </button>
        </div>
      </div>
      <p className="desc">
        {translate("Connect as many providers as you want — cloud models, local models, or custom endpoints — and define priority by function. Installed a CLI? Click Refresh providers; Maestro does not need to restart.")}
      </p>
      {scanSummary ? <div className="provider-feedback success" role="status">{scanSummary}</div> : null}
      {refreshError ? <div className="provider-feedback error" role="alert">{refreshError}</div> : null}
      <div className="providers-stack">
        <ProviderManager
          agents={data.agents}
          externalPolicy={policy}
          policyVersion={(policy?.controls ?? []).map((control) => `${control.providerId}:${control.mode}`).join("|")}
          setPolicy={setPolicy}
          onPolicyChanged={refreshPolicy}
          onChanged={() => { void onRefresh?.(); }}
        />
        <div className="routing-divider" aria-hidden="true" />
        <AgentDock agents={data.agents} policy={policy} onPolicyChanged={refreshPolicy} />
      </div>
    </div>
  );
}
