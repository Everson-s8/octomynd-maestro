import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { DashboardData, fetchDashboard } from "./api";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { TaskComposer } from "./components/TaskComposer";
import { TaskDetail } from "./components/TaskDetail";
import { ErrorBanner } from "./components/ErrorBanner";
import { LoadingSpinner } from "./components/LoadingSpinner";
import { statusOrder } from "./helpers";

import { DashboardPage } from "./pages/DashboardPage";
import { BacklogPage } from "./pages/BacklogPage";
import { ReviewPage } from "./pages/ReviewPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { SettingsPage } from "./pages/SettingsPage";

export default function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [globalFilter] = useState<"all" | "attention" | "active">("active");

  const refresh = useCallback(async (showActivity = false) => {
    const controller = new AbortController();
    if (showActivity) setIsRefreshing(true);
    try {
      const nextData = await fetchDashboard(controller.signal);
      setData(nextData);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Falha ao carregar a central.");
    } finally {
      setIsRefreshing(false);
    }
    return () => controller.abort();
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const activeTasks = useMemo(() => {
    if (!data) return [];
    return [...data.tasks]
      .filter((task) => {
        if (globalFilter === "all") return true;
        if (globalFilter === "attention") {
          return [
            "awaiting_human",
            "changes_requested",
            "blocked",
            "waiting_quota",
            "waiting_provider",
            "waiting_dependency",
            "failed"
          ].includes(task.status);
        }
        return !["done", "failed", "rejected", "cancelled"].includes(task.status);
      })
      .sort((left, right) => statusOrder.indexOf(left.status) - statusOrder.indexOf(right.status));
  }, [data]);

  const selectedTask = data?.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedGoal = data?.goals.find((goal) => goal.taskId === selectedTaskId) ?? null;

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  return (
    <BrowserRouter>
      <div className={`app-shell ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}>
        <Sidebar collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)} />

        <main className="control-room">
          <Topbar
            data={data}
            isRefreshing={isRefreshing}
            onRefresh={() => void refresh(true)}
            onCreateTask={() => setTaskPanelOpen(true)}
          />

          {error ? <ErrorBanner message={error} onRetry={() => void refresh(true)} /> : null}

          {data ? (
            <Routes>
              <Route
                path="/"
                element={
                  <DashboardPage
                    data={data}
                    activeTasks={activeTasks}
                    onOpenTask={setSelectedTaskId}
                    onRefresh={() => refresh(true)}
                  />
                }
              />
              <Route
                path="/backlog"
                element={
                  <BacklogPage
                    data={data}
                    onOpenTask={setSelectedTaskId}
                    onRefresh={() => refresh(true)}
                    onCreateTask={() => setTaskPanelOpen(true)}
                  />
                }
              />
              <Route path="/reviews" element={<ReviewPage data={data} onRefresh={() => refresh(true)} />} />
              <Route path="/projects" element={<ProjectsPage data={data} />} />
              <Route path="/providers" element={<ProvidersPage data={data} />} />
              <Route path="/analytics" element={<AnalyticsPage data={data} onRefresh={() => refresh(true)} />} />
              <Route path="/settings" element={<SettingsPage data={data} onRefresh={() => refresh(true)} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          ) : null}
        </main>

        <TaskComposer
          open={taskPanelOpen}
          projects={data?.projects ?? []}
          onClose={() => setTaskPanelOpen(false)}
          onCreated={async () => {
            setTaskPanelOpen(false);
            await refresh(true);
          }}
        />
        <TaskDetail
          task={selectedTask}
          goal={selectedGoal}
          onClose={() => setSelectedTaskId(null)}
          onPrepared={async () => {
            await refresh(true);
          }}
          onDeleted={async () => {
            setSelectedTaskId(null);
            await refresh(true);
          }}
        />
      </div>
    </BrowserRouter>
  );
}
