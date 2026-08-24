import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DashboardData,
  configureAntigravityPermissions,
  fetchAntigravityPermissionStatus,
  fetchProviderPolicy,
  AntigravityPermissionStatus,
  ProviderPolicySnapshot,
  ProviderRescanEntry,
  refreshProviders,
  rescanProviders
} from "../api";
import { AgentDock } from "../components/AgentDock";
import { ProviderManager } from "../components/ProviderManager";

export interface ProvidersPageProps {
  data: DashboardData;
  onRefresh?: () => void | Promise<void>;
}

export function ProvidersPage({ data, onRefresh }: ProvidersPageProps) {
  const [policy, setPolicy] = useState<ProviderPolicySnapshot | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanSummary, setScanSummary] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState("");
  const [antigravityPermissions, setAntigravityPermissions] = useState<AntigravityPermissionStatus | null>(null);
  const [permissionsBusy, setPermissionsBusy] = useState(false);

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

  const antigravityInstalled = useMemo(
    () => data.agents.some((agent) => agent.id === "antigravity" && agent.state !== "offline"),
    [data.agents]
  );

  useEffect(() => {
    if (!antigravityInstalled) return;
    void fetchAntigravityPermissionStatus().then(setAntigravityPermissions).catch(() => undefined);
  }, [antigravityInstalled]);

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
    return `${installed.length} CLI(s) instalado(s) · ${authenticated.length} sessao(oes) autenticada(s)` +
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
      setRefreshError(error instanceof Error ? error.message : "Falha ao reexaminar providers.");
    } finally {
      setScanning(false);
    }
  }, [onRefresh, refreshPolicy]);

  const handleConfigureAntigravityPermissions = useCallback(async () => {
    const accepted = window.confirm(
      "Permitir que o Antigravity execute comandos comuns de desenvolvimento (git, node, npm, npx e gerenciadores de projeto) sem pedir confirmacao a cada etapa?"
    );
    if (!accepted) return;
    setPermissionsBusy(true);
    setRefreshError("");
    try {
      setAntigravityPermissions(await configureAntigravityPermissions());
      setScanSummary("Antigravity configurado para executar tarefas de desenvolvimento sem interrupcoes.");
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Nao foi possivel configurar as permissoes do Antigravity.");
    } finally {
      setPermissionsBusy(false);
    }
  }, []);

  return (
    <div className="providers-page">
      <div className="top">
        <div>
          <div className="eyebrow">AI Routing</div>
          <h1>Providers</h1>
        </div>
        <div className="top-actions">
          <span className="provider-summary">{installed.length} CLI(s) detectado(s) · {ready.length} pronto(s) para uso</span>
          {antigravityInstalled && !antigravityPermissions?.configured ? (
            <button type="button" className="btn-ghost" onClick={() => void handleConfigureAntigravityPermissions()} disabled={permissionsBusy}>
              {permissionsBusy ? "Configurando…" : "Permitir execução do Antigravity"}
            </button>
          ) : null}
          <button type="button" className="btn-ghost" onClick={() => void handleRescan()} disabled={scanning}>
            {scanning ? "Reexaminando…" : "Atualizar providers"}
          </button>
        </div>
      </div>
      <p className="desc">
        Conecte quantos providers quiser — modelos de nuvem, locais ou endpoints customizados — e
        defina a ordem de prioridade por função. Instalou um CLI agora? Clique em “Atualizar
        providers” — não precisa reiniciar o Maestro.
      </p>
      {scanSummary ? <div className="provider-feedback success" role="status">{scanSummary}</div> : null}
      {refreshError ? <div className="provider-feedback error" role="alert">{refreshError}</div> : null}
      <div className="prov-grid">
        <ProviderManager
          agents={data.agents}
          externalPolicy={policy}
          policyVersion={(policy?.controls ?? []).map((control) => `${control.providerId}:${control.mode}`).join("|")}
          setPolicy={setPolicy}
          onPolicyChanged={refreshPolicy}
          onChanged={() => { void onRefresh?.(); }}
        />
        <AgentDock agents={data.agents} policy={policy} onPolicyChanged={refreshPolicy} />
      </div>
    </div>
  );
}
