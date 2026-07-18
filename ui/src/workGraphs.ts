import type { DashboardWorkGraph } from "./api.js";

export function formatWorkGraphDuration(durationMs: number | null): string {
  if (durationMs === null) return "em andamento";
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
}

export function isWorkGraphCancellable(graph: Pick<DashboardWorkGraph, "status" | "cancellable">): boolean {
  return graph.cancellable && !["completed", "blocked", "cancelled"].includes(graph.status);
}
