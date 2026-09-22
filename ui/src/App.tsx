import { useCallback, useEffect, useState } from "react";
import { BrowserRouter } from "react-router-dom";
import { DashboardData, fetchDashboard } from "./api";
import { ErrorBanner } from "./components/ErrorBanner";
import { LoadingSpinner } from "./components/LoadingSpinner";
import { TaskComposer } from "./components/TaskComposer";
import { ProjectModal } from "./components/ProjectModal";
import { RuntimeErrorBoundary } from "./components/RuntimeErrorBoundary";
import { MaestroV2 } from "./pages/MaestroV2";
import { useI18n, translate } from "./i18n";
import { resetOnboarding } from "./components/FirstRunOnboarding";
import { DesktopUpdateStatus, installDesktopUpdate } from "./external-links";

function getDesktopBridge() {
  return (window as Window & {
      maestroDesktop?: {
        installUpdate?: () => Promise<unknown>;
        onUpdateStatus?: (callback: (status: DesktopUpdateStatus) => void) => (() => void) | void;
    };
  }).maestroDesktop;
}

export default function App() {
  // Subscribe the root to locale changes so legacy presentation components
  // that use the pure translate helper also rerender immediately.
  const { locale } = useI18n();
  void locale;
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus | null>(null);

  const refresh = useCallback(async (activity = false) => {
    if (activity) setRefreshing(true);
    try {
      setData(await fetchDashboard());
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : translate("Unable to load Maestro."));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    const unsubscribe = getDesktopBridge()?.onUpdateStatus?.((status) => {
      setUpdateStatus((previous) => ({ ...previous, ...status }));
      setUpdateError(status.event === "error" ? status.message || translate("Automatic updates are unavailable.") : null);
    });
    return typeof unsubscribe === "function" ? unsubscribe : undefined;
  }, []);

  const handleRefresh = useCallback(() => refresh(true), [refresh]);
  const handleCreate = useCallback(() => setComposerOpen(true), []);
  const handleRegisterProject = useCallback(() => setProjectModalOpen(true), []);
  const handleRestartOnboarding = useCallback(() => {
    resetOnboarding();
    window.location.reload();
  }, []);

  if (!data && !error) return <LoadingSpinner />;
  return <RuntimeErrorBoundary><BrowserRouter>
    {error ? <ErrorBanner message={error} onRetry={() => void refresh(true)} /> : null}
    {updateError ? <div className="error-banner" role="alert">
      <span>{translate("Automatic updates are unavailable.")} {updateError}</span>
      <button onClick={() => setUpdateError(null)}>{translate("Dismiss")}</button>
    </div> : null}
    {data ? <div className="maestro-runtime-badge" role="status">
      <span>{translate("Maestro")} v{data.daemon.version}</span>
      {updateStatus?.event === "downloading" || updateStatus?.event === "progress" ? (
        <span>{translate("Update available")} {updateStatus.version ? `v${updateStatus.version}` : ""} · {updateStatus.percent ?? 0}%</span>
      ) : updateStatus?.event === "ready" ? (
        <button type="button" onClick={() => void installDesktopUpdate()}>
          {translate("Restart to update")} {updateStatus.version ? `v${updateStatus.version}` : ""}
        </button>
      ) : null}
    </div> : null}
    {data ? <MaestroV2 data={data} onRefresh={handleRefresh} onCreate={handleCreate} onRegisterProject={handleRegisterProject} onRestartOnboarding={handleRestartOnboarding} refreshing={refreshing} /> : null}
    <TaskComposer open={composerOpen} projects={data?.projects ?? []} onClose={() => setComposerOpen(false)} onCreated={async () => { setComposerOpen(false); await refresh(true); }} />
    <ProjectModal open={projectModalOpen} onClose={() => setProjectModalOpen(false)} onCreated={async () => { setProjectModalOpen(false); await refresh(true); }} />
  </BrowserRouter></RuntimeErrorBoundary>;
}
