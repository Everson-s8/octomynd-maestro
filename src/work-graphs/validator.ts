import type { AgentCapability } from "../agents/types.js";
import type { WorkGraphDetails, WorkerNodeRecord, WorkerRole } from "./types.js";

const MAX_NODES = 4;
const MAX_ATTEMPTS = 3;
const MAX_DEADLINE_MS = 6 * 60_000;
const MAX_OUTPUT_CHARS = 12_000;

const ROLE_CAPABILITIES: Record<WorkerRole, ReadonlySet<AgentCapability>> = {
  researcher: new Set(["research"]),
  planner: new Set(["planning"]),
  implementer: new Set(["coding"]),
  tester: new Set(["testing"]),
  reviewer: new Set(["reviewing"])
};

export type WorkGraphValidationIssueCode =
  | "too_many_nodes"
  | "invalid_parallelism"
  | "missing_dependency"
  | "self_dependency"
  | "cycle"
  | "missing_output_contract"
  | "role_capability_mismatch"
  | "provider_unavailable"
  | "writer_limit"
  | "writer_scope_missing"
  | "read_only_write_scope"
  | "budget_exceeded";

export type WorkGraphValidationIssue = {
  code: WorkGraphValidationIssueCode;
  message: string;
  nodeKey?: string;
};

export type WorkGraphValidationResult = {
  valid: boolean;
  issues: WorkGraphValidationIssue[];
  topologicalOrder: string[];
};

export function validateWorkGraph(
  graph: WorkGraphDetails,
  availableCapabilities?: ReadonlySet<AgentCapability>
): WorkGraphValidationResult {
  const issues: WorkGraphValidationIssue[] = [];
  if (graph.nodes.length > MAX_NODES) {
    issues.push({ code: "too_many_nodes", message: `Work Graph exceeds the ${MAX_NODES}-node limit.` });
  }
  if (graph.maxParallelReaders < 1 || graph.maxParallelReaders > 2) {
    issues.push({ code: "invalid_parallelism", message: "Work Graph permits at most two parallel readers." });
  }
  const byKey = new Map(graph.nodes.map((node) => [node.key, node]));
  const writers = graph.nodes.filter((node) => node.mode === "writer");
  if (writers.length > 1) {
    issues.push({ code: "writer_limit", message: "The first Work Graph release permits one writer only." });
  }

  for (const node of graph.nodes) {
    validateNode(node, byKey, availableCapabilities, issues);
  }

  const topologicalOrder = topologicalSort(graph.nodes);
  if (topologicalOrder.length !== graph.nodes.length) {
    issues.push({ code: "cycle", message: "Work Graph dependencies contain a cycle." });
  }
  return { valid: issues.length === 0, issues, topologicalOrder };
}

function validateNode(
  node: WorkerNodeRecord,
  byKey: ReadonlyMap<string, WorkerNodeRecord>,
  availableCapabilities: ReadonlySet<AgentCapability> | undefined,
  issues: WorkGraphValidationIssue[]
): void {
  if (!node.outputContract.trim()) {
    issues.push({ code: "missing_output_contract", message: "Worker requires an output contract.", nodeKey: node.key });
  }
  if (!ROLE_CAPABILITIES[node.role].has(node.capability)) {
    issues.push({
      code: "role_capability_mismatch",
      message: `${node.role} cannot request ${node.capability}.`,
      nodeKey: node.key
    });
  }
  if (availableCapabilities && !availableCapabilities.has(node.capability)) {
    issues.push({
      code: "provider_unavailable",
      message: `No ready Provider advertises ${node.capability}.`,
      nodeKey: node.key
    });
  }
  if (node.mode === "writer" && node.writeScope.length === 0) {
    issues.push({ code: "writer_scope_missing", message: "Writer requires an explicit write scope.", nodeKey: node.key });
  }
  if (node.mode === "read_only" && node.writeScope.length > 0) {
    issues.push({ code: "read_only_write_scope", message: "Read-only Worker cannot declare write scope.", nodeKey: node.key });
  }
  if (
    node.maxAttempts > MAX_ATTEMPTS
    || node.deadlineMs > MAX_DEADLINE_MS
    || node.outputChars > MAX_OUTPUT_CHARS
  ) {
    issues.push({ code: "budget_exceeded", message: "Worker exceeds bounded execution limits.", nodeKey: node.key });
  }
  for (const dependency of node.dependsOn) {
    if (dependency === node.key) {
      issues.push({ code: "self_dependency", message: "Worker cannot depend on itself.", nodeKey: node.key });
    } else if (!byKey.has(dependency)) {
      issues.push({
        code: "missing_dependency",
        message: `Worker dependency does not exist: ${dependency}.`,
        nodeKey: node.key
      });
    }
  }
}

function topologicalSort(nodes: WorkerNodeRecord[]): string[] {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const indegree = new Map(nodes.map((node) => [node.key, 0]));
  const outgoing = new Map(nodes.map((node) => [node.key, [] as string[]]));
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!byKey.has(dependency) || dependency === node.key) continue;
      indegree.set(node.key, (indegree.get(node.key) ?? 0) + 1);
      outgoing.get(dependency)?.push(node.key);
    }
  }
  const ready = nodes.filter((node) => indegree.get(node.key) === 0).map((node) => node.key);
  const order: string[] = [];
  while (ready.length > 0) {
    const key = ready.shift()!;
    order.push(key);
    for (const target of outgoing.get(key) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  return order;
}

export type WorkGraphComplexity = {
  mode: "single_agent" | "work_graph_candidate";
  score: number;
  reasons: string[];
};

export function classifyWorkGraphComplexity(input: {
  taskText: string;
  acceptanceCriteria?: string[];
  estimatedFiles?: number;
}): WorkGraphComplexity {
  const text = input.taskText.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  const signals: Array<[RegExp, string]> = [
    [/\b(architecture|arquitetura|migration|migracao|redesign)\b/, "architectural change"],
    [/\b(security|seguranca|audit|auditoria)\b/, "independent risk analysis"],
    [/\b(research|pesquisa|investigate|investigar)\b/, "research before implementation"],
    [/\b(parallel|paralel|multiple modules|multiplos modulos)\b/, "parallelizable scope"]
  ];
  for (const [pattern, reason] of signals) {
    if (pattern.test(text)) {
      score += 1;
      reasons.push(reason);
    }
  }
  if ((input.acceptanceCriteria?.length ?? 0) >= 4) {
    score += 1;
    reasons.push("many acceptance criteria");
  }
  if ((input.estimatedFiles ?? 0) >= 8) {
    score += 1;
    reasons.push("broad file impact");
  }
  if (input.taskText.length >= 500) {
    score += 1;
    reasons.push("large task contract");
  }
  return { mode: score >= 2 ? "work_graph_candidate" : "single_agent", score, reasons };
}

