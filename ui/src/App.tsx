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

  const handleRefresh = useCallback(() => refresh(true), [refresh]);
  const handleCreate = useCallback(() => setComposerOpen(true), []);
  const handleRegisterProject = useCallback(() => setProjectModalOpen(true), []);

  if (!data && !error) return <LoadingSpinner />;
  return <RuntimeErrorBoundary><BrowserRouter>
    {error ? <ErrorBanner message={error} onRetry={() => void refresh(true)} /> : null}
    {data ? <MaestroV2 data={data} onRefresh={handleRefresh} onCreate={handleCreate} onRegisterProject={handleRegisterProject} refreshing={refreshing} /> : null}
    <TaskComposer open={composerOpen} projects={data?.projects ?? []} onClose={() => setComposerOpen(false)} onCreated={async () => { setComposerOpen(false); await refresh(true); }} />
    <ProjectModal open={projectModalOpen} onClose={() => setProjectModalOpen(false)} onCreated={async () => { setProjectModalOpen(false); await refresh(true); }} />
  </BrowserRouter></RuntimeErrorBoundary>;
}
