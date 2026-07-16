import type { WorkGraphDetails, WorkerNodeRecord } from "./types.js";

export type WorkerSchedule = {
  ready: WorkerNodeRecord[];
  waiting: WorkerNodeRecord[];
  complete: boolean;
  blocked: boolean;
};

export function scheduleWorkerBatch(graph: WorkGraphDetails): WorkerSchedule {
  const completed = new Set(
    graph.nodes.filter((node) => node.status === "completed").map((node) => node.key)
  );
  const active = graph.nodes.filter((node) => ["running", "waiting_provider"].includes(node.status));
  const terminal = graph.nodes.filter((node) => ["completed", "cancelled"].includes(node.status));
  const failed = graph.nodes.filter((node) => ["blocked", "failed"].includes(node.status));
  if (terminal.length === graph.nodes.length) {
    return { ready: [], waiting: [], complete: true, blocked: false };
  }
  if (failed.some((node) => node.status === "blocked" || node.attemptCount >= node.maxAttempts)) {
    return { ready: [], waiting: graph.nodes.filter(isPending), complete: false, blocked: true };
  }

  const candidates = graph.nodes.filter((node) =>
    isPending(node) && node.dependsOn.every((dependency) => completed.has(dependency))
  );
  const waiting = graph.nodes.filter((node) =>
    isPending(node) && !node.dependsOn.every((dependency) => completed.has(dependency))
  );
  if (active.some((node) => node.mode === "writer")) {
    return { ready: [], waiting: [...waiting, ...candidates], complete: false, blocked: false };
  }

  const writer = candidates.find((node) => node.mode === "writer");
  if (writer) {
    if (active.length > 0) return { ready: [], waiting: [...waiting, ...candidates], complete: false, blocked: false };
    return {
      ready: [writer],
      waiting: [...waiting, ...candidates.filter((node) => node.id !== writer.id)],
      complete: false,
      blocked: false
    };
  }

  const activeReaders = active.filter((node) => node.mode === "read_only").length;
  const available = Math.max(0, graph.maxParallelReaders - activeReaders);
  const ready = candidates.filter((node) => node.mode === "read_only").slice(0, available);
  return {
    ready,
    waiting: [...waiting, ...candidates.filter((node) => !ready.some((selected) => selected.id === node.id))],
    complete: false,
    blocked: false
  };
}

function isPending(node: WorkerNodeRecord): boolean {
  return ["pending", "ready", "failed"].includes(node.status);
}

