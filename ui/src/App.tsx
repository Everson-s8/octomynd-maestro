import { useCallback, useEffect, useState } from "react";
import { BrowserRouter } from "react-router-dom";
import { DashboardData, fetchDashboard } from "./api";
import { ErrorBanner } from "./components/ErrorBanner";
import { LoadingSpinner } from "./components/LoadingSpinner";
import { TaskComposer } from "./components/TaskComposer";
import { ProjectModal } from "./components/ProjectModal";
import { DesktopUpdateBadge } from "./components/DesktopUpdateBadge";
import { RuntimeErrorBoundary } from "./components/RuntimeErrorBoundary";
import { MaestroV2 } from "./pages/MaestroV2";
import { useI18n, translate } from "./i18n";
import { resetOnboarding } from "./components/FirstRunOnboarding";
import { DesktopUpdateStatus, installDesktopUpdate, openExternalUrl, retryDesktopUpdate } from "./external-links";

const RELEASES_URL = "https://github.com/Octomynd/octomynd-maestro/releases/latest";

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
  const [retryingUpdate, setRetryingUpdate] = useState(false);
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
  const handleRetryUpdate = useCallback(async () => {
    setRetryingUpdate(true);
    setUpdateError(null);
    try {
      if (!(await retryDesktopUpdate())) setUpdateError(translate("Automatic update retry could not start."));
    } catch (retryError) {
      setUpdateError(retryError instanceof Error ? retryError.message : translate("Automatic update retry could not start."));
    } finally {
      setRetryingUpdate(false);
    }
  }, []);
  const handleInstallUpdate = useCallback(async () => {
    try {
      if (!(await installDesktopUpdate())) setUpdateError(translate("The update is not ready to install."));
    } catch (installError) {
      setUpdateError(installError instanceof Error ? installError.message : translate("The update is not ready to install."));
    }
  }, []);

  if (!data && !error) return <LoadingSpinner />;
  return <RuntimeErrorBoundary><BrowserRouter>
    {error ? <ErrorBanner message={error} onRetry={() => void refresh(true)} /> : null}
    {updateError ? <div className="error-banner" role="alert">
      <span>{translate("Automatic updates are unavailable.")} {updateError}</span>
      <button type="button" disabled={retryingUpdate} onClick={() => void handleRetryUpdate()}>
        {retryingUpdate ? translate("Checking for updates…") : translate("Retry update")}
      </button>
      <button type="button" onClick={() => openExternalUrl(RELEASES_URL)}>{translate("Install manually")}</button>
      <button onClick={() => setUpdateError(null)}>{translate("Dismiss")}</button>
    </div> : null}
    {data ? <DesktopUpdateBadge version={data.daemon.version} status={updateStatus} onInstall={() => void handleInstallUpdate()} /> : null}
    {data ? <MaestroV2 data={data} onRefresh={handleRefresh} onCreate={handleCreate} onRegisterProject={handleRegisterProject} onRestartOnboarding={handleRestartOnboarding} refreshing={refreshing} /> : null}
    <TaskComposer open={composerOpen} projects={data?.projects ?? []} onClose={() => setComposerOpen(false)} onCreated={async () => { setComposerOpen(false); await refresh(true); }} />
    <ProjectModal open={projectModalOpen} onClose={() => setProjectModalOpen(false)} onCreated={async () => { setProjectModalOpen(false); await refresh(true); }} />
  </BrowserRouter></RuntimeErrorBoundary>;
}
