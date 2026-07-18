import type { AgentCapability } from "../agents/types.js";
import type { WorkerBudget, WorkerMode, WorkerRole } from "../work-graphs/types.js";
import { workerBudgetExceedsLimits, workerDeadlineLimitMs } from "../work-graphs/validator.js";

export type FeatureTaskParallelMode = "serial" | "parallel";

// Role/capability/mode compatibility mirrors src/work-graphs/validator.ts. This contract-level
// check fails fast at Feature Plan creation time; validateWorkGraph remains the authoritative
// gate immediately before execution (defense in depth, not a replacement).
const WORK_GRAPH_NODE_ROLE_CAPABILITY: Record<WorkerRole, AgentCapability> = {
  researcher: "research",
  planner: "planning",
  implementer: "coding",
  tester: "testing",
  reviewer: "reviewing"
};

const WORK_GRAPH_NODE_ROLE_MODE: Record<WorkerRole, WorkerMode> = {
  researcher: "read_only",
  planner: "read_only",
  implementer: "writer",
  tester: "read_only",
  reviewer: "read_only"
};

const WORK_GRAPH_DEFAULT_BUDGET: WorkerBudget = { maxAttempts: 2, deadlineMs: 5 * 60_000, outputChars: 8_000 };
const WORK_GRAPH_MAX_NODES = 4;

export type FeatureWorkGraphNodeRequestInput = {
  key: string;
  role: WorkerRole;
  capability: AgentCapability;
  objective: string;
  dependsOn?: string[];
  outputContract: string;
  mode?: WorkerMode;
  writeScope?: string[];
  budget?: Partial<WorkerBudget>;
};

export type FeatureWorkGraphRequestInput = {
  objective?: string;
  maxParallelReaders?: number;
  nodes: FeatureWorkGraphNodeRequestInput[];
};

export type FeatureWorkGraphNodeRequest = {
  key: string;
  role: WorkerRole;
  capability: AgentCapability;
  objective: string;
  dependsOn: string[];
  outputContract: string;
  mode: WorkerMode;
  writeScope: string[];
  budget: WorkerBudget;
};

export type FeatureWorkGraphRequest = {
  objective: string;
  maxParallelReaders: number;
  nodes: FeatureWorkGraphNodeRequest[];
};

export type FeatureTaskContractInput = {
  taskId: number;
  objective?: string;
  acceptanceCriteria?: string[];
  excludedScope?: string[];
  mutationScope?: string[];
  dependsOnTaskIds?: number[];
  parallelMode?: FeatureTaskParallelMode;
  workGraphRequest?: FeatureWorkGraphRequestInput;
};

export type FeatureTaskContract = {
  objective: string;
  acceptanceCriteria: string[];
  excludedScope: string[];
  mutationScope: string[];
  dependsOnTaskIds: number[];
  parallelMode: FeatureTaskParallelMode;
  workGraphRequest: FeatureWorkGraphRequest | null;
};

export type FeatureTaskGraphNode = {
  taskId: number;
  position: number;
  contract: FeatureTaskContract;
};

export function normalizeFeatureTaskContracts(
  taskIds: number[],
  inputs: FeatureTaskContractInput[] | undefined,
  taskText: (taskId: number) => string
): Map<number, FeatureTaskContract> {
  if (!inputs) return legacySerialContracts(taskIds, taskText);
  const byTask = new Map<number, FeatureTaskContractInput>();
  for (const input of inputs) {
    if (!taskIds.includes(input.taskId)) {
      throw new Error(`Task contract references Task #${input.taskId} outside the Feature Plan.`);
    }
    if (byTask.has(input.taskId)) {
      throw new Error(`Task #${input.taskId} has more than one execution contract.`);
    }
    byTask.set(input.taskId, input);
  }
  if (byTask.size !== taskIds.length) {
    const missing = taskIds.filter((taskId) => !byTask.has(taskId));
    throw new Error(`Missing execution contract for Task(s): ${missing.map((id) => `#${id}`).join(", ")}.`);
  }

  const contracts = new Map<number, FeatureTaskContract>();
  for (const taskId of taskIds) {
    const input = byTask.get(taskId)!;
    const objective = input.objective?.trim() || taskText(taskId).trim();
    const acceptanceCriteria = normalizeTextList(input.acceptanceCriteria);
    const excludedScope = normalizeTextList(input.excludedScope);
    const mutationScope = normalizeMutationScope(input.mutationScope);
    const dependsOnTaskIds = uniquePositiveIds(input.dependsOnTaskIds ?? [], `Task #${taskId} dependency`);
    const parallelMode = input.parallelMode ?? "serial";
    if (objective.length < 8) throw new Error(`Task #${taskId} objective must be at least 8 characters.`);
    if (acceptanceCriteria.length === 0) {
      throw new Error(`Task #${taskId} requires at least one acceptance criterion.`);
    }
    if (parallelMode === "parallel" && mutationScope.includes("**")) {
      throw new Error(`Task #${taskId} cannot use parallel mode with an unrestricted mutation scope.`);
    }
    const workGraphRequest = normalizeWorkGraphRequest(input.workGraphRequest, mutationScope, taskId);
    contracts.set(taskId, {
      objective,
      acceptanceCriteria,
      excludedScope,
      mutationScope,
      dependsOnTaskIds,
      parallelMode,
      workGraphRequest
    });
  }
  validateFeatureTaskGraph(taskIds.map((taskId, index) => ({
    taskId,
    position: index + 1,
    contract: contracts.get(taskId)!
  })));
  return contracts;
}

export function legacyFeatureTaskContract(
  taskId: number,
  taskText: string,
  previousTaskId?: number
): FeatureTaskContract {
  return {
    objective: taskText.trim(),
    acceptanceCriteria: [`A Task #${taskId} entrega seu escopo com testes e evidencias verificaveis.`],
    excludedScope: [],
    mutationScope: ["**"],
    dependsOnTaskIds: previousTaskId ? [previousTaskId] : [],
    parallelMode: "serial",
    workGraphRequest: null
  };
}

export function validateFeatureTaskGraph(nodes: FeatureTaskGraphNode[]): void {
  const byId = new Map(nodes.map((node) => [node.taskId, node]));
  for (const node of nodes) {
    for (const dependencyId of node.contract.dependsOnTaskIds) {
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        throw new Error(`Task #${node.taskId} depends on Task #${dependencyId} outside the Feature Plan.`);
      }
      if (dependencyId === node.taskId) throw new Error(`Task #${node.taskId} cannot depend on itself.`);
      if (dependency.position >= node.position) {
        throw new Error(`Task #${node.taskId} dependency #${dependencyId} must appear earlier in the Feature Plan.`);
      }
    }
  }
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (taskId: number) => {
    if (visiting.has(taskId)) throw new Error(`Feature Plan task dependency cycle includes Task #${taskId}.`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependencyId of byId.get(taskId)!.contract.dependsOnTaskIds) visit(dependencyId);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const node of nodes) visit(node.taskId);
}

export function transitiveDependencyIds(nodes: FeatureTaskGraphNode[], taskId: number): number[] {
  const byId = new Map(nodes.map((node) => [node.taskId, node]));
  const target = byId.get(taskId);
  if (!target) return [];
  const included = new Set<number>();
  const collect = (current: number) => {
    for (const dependencyId of byId.get(current)?.contract.dependsOnTaskIds ?? []) {
      if (included.has(dependencyId)) continue;
      included.add(dependencyId);
      collect(dependencyId);
    }
  };
  collect(taskId);
  return nodes
    .filter((node) => included.has(node.taskId))
    .sort((left, right) => left.position - right.position)
    .map((node) => node.taskId);
}

export function featureTaskContractsConflict(
  left: FeatureTaskContract,
  right: FeatureTaskContract
): boolean {
  if (left.parallelMode === "serial" || right.parallelMode === "serial") return true;
  if (left.mutationScope.length === 0 || right.mutationScope.length === 0) return false;
  return left.mutationScope.some((leftScope) => (
    right.mutationScope.some((rightScope) => scopesOverlap(leftScope, rightScope))
  ));
}

function legacySerialContracts(
  taskIds: number[],
  taskText: (taskId: number) => string
): Map<number, FeatureTaskContract> {
  const contracts = new Map<number, FeatureTaskContract>();
  taskIds.forEach((taskId, index) => {
    contracts.set(taskId, legacyFeatureTaskContract(taskId, taskText(taskId), taskIds[index - 1]));
  });
  return contracts;
}

function normalizeTextList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function normalizeMutationScope(values: string[] | undefined): string[] {
  return normalizeTextList(values).map((value) => {
    const scope = value.replace(/\\/g, "/").replace(/^\.\//, "");
    if (scope.startsWith("/") || /^[a-z]:\//i.test(scope) || scope.split("/").includes("..")) {
      throw new Error(`Mutation scope must stay workspace-relative: ${scope}`);
    }
    const withoutTrailingSlash = scope.replace(/\/+$/, "");
    return withoutTrailingSlash === "" || withoutTrailingSlash === "." ? "**" : withoutTrailingSlash;
  });
}

function normalizeWorkGraphRequest(
  request: FeatureWorkGraphRequestInput | undefined,
  mutationScope: string[],
  taskId: number
): FeatureWorkGraphRequest | null {
  if (!request) return null;
  if (!request.nodes || request.nodes.length === 0) {
    throw new Error(`Task #${taskId} work graph request requires at least one node.`);
  }
  if (request.nodes.length > WORK_GRAPH_MAX_NODES) {
    throw new Error(`Task #${taskId} work graph request exceeds the ${WORK_GRAPH_MAX_NODES}-node limit.`);
  }
  const objective = request.objective?.trim() || `Work Graph for Task #${taskId}`;
  const keys = new Set<string>();
  let writerCount = 0;
  const nodes: FeatureWorkGraphNodeRequest[] = request.nodes.map((node) => {
    const key = node.key?.trim().toLowerCase();
    if (!key || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(key)) {
      throw new Error(`Task #${taskId} work graph node has an invalid key: ${node.key}`);
    }
    if (keys.has(key)) throw new Error(`Task #${taskId} work graph has a duplicate node key: ${key}`);
    keys.add(key);

    const expectedCapability = WORK_GRAPH_NODE_ROLE_CAPABILITY[node.role];
    if (!expectedCapability) throw new Error(`Task #${taskId} work graph node "${key}" has an unsupported role.`);
    if (node.capability !== expectedCapability) {
      throw new Error(`Task #${taskId} work graph node "${key}" role ${node.role} cannot request ${node.capability}.`);
    }

    const expectedMode = WORK_GRAPH_NODE_ROLE_MODE[node.role];
    const mode = node.mode ?? expectedMode;
    if (mode !== expectedMode) {
      throw new Error(`Task #${taskId} work graph node "${key}" role ${node.role} must run as ${expectedMode}.`);
    }
    if (mode === "writer") writerCount += 1;

    const objectiveText = requiredNonEmpty(node.objective, `Task #${taskId} work graph node "${key}" objective`);
    const outputContract = requiredNonEmpty(
      node.outputContract,
      `Task #${taskId} work graph node "${key}" output contract`
    );
    const dependsOn = [...new Set((node.dependsOn ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))];
    const writeScope = normalizeMutationScope(node.writeScope ?? []);

    if (mode === "writer") {
      if (writeScope.length === 0) {
        throw new Error(`Task #${taskId} work graph writer node "${key}" requires an explicit write scope.`);
      }
      for (const scope of writeScope) {
        if (!scopeWithinMutationScope(scope, mutationScope)) {
          throw new Error(
            `Task #${taskId} work graph writer node "${key}" write scope must stay inside the Task mutation scope: ${scope}`
          );
        }
      }
    } else if (writeScope.length > 0) {
      throw new Error(`Task #${taskId} work graph read-only node "${key}" cannot declare a write scope.`);
    }

    const budget = { ...WORK_GRAPH_DEFAULT_BUDGET, ...node.budget };
    if (workerBudgetExceedsLimits(node.role, budget)) {
      throw new Error(
        `Task #${taskId} work graph node "${key}" exceeds its bounded execution limits `
        + `(deadline max ${workerDeadlineLimitMs(node.role)} ms).`
      );
    }
    return {
      key,
      role: node.role,
      capability: node.capability,
      objective: objectiveText,
      dependsOn,
      outputContract,
      mode,
      writeScope,
      budget
    };
  });

  if (writerCount > 1) {
    throw new Error(`Task #${taskId} work graph permits at most one writer node.`);
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.key) {
        throw new Error(`Task #${taskId} work graph node "${node.key}" cannot depend on itself.`);
      }
      if (!keys.has(dependency)) {
        throw new Error(`Task #${taskId} work graph node "${node.key}" depends on unknown node "${dependency}".`);
      }
    }
  }
  assertAcyclicWorkGraphNodes(nodes, taskId);

  const maxParallelReaders = request.maxParallelReaders ?? 2;
  if (!Number.isInteger(maxParallelReaders) || maxParallelReaders < 1 || maxParallelReaders > 2) {
    throw new Error(`Task #${taskId} work graph maxParallelReaders must be 1 or 2.`);
  }

  return { objective, maxParallelReaders, nodes };
}

function assertAcyclicWorkGraphNodes(
  nodes: Array<{ key: string; dependsOn: string[] }>,
  taskId: number
): void {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) {
      throw new Error(`Task #${taskId} work graph has a dependency cycle including node "${key}".`);
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key)!.dependsOn) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const node of nodes) visit(node.key);
}

function scopeWithinMutationScope(writeScope: string, mutationScope: string[]): boolean {
  if (mutationScope.includes("**")) return true;
  const writePrefix = staticPrefix(writeScope);
  return mutationScope.some((scope) => {
    if (scope === "**") return true;
    const scopePrefix = staticPrefix(scope);
    return writePrefix === scopePrefix || writePrefix.startsWith(`${scopePrefix}/`);
  });
}

function requiredNonEmpty(value: string | undefined, label: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

function uniquePositiveIds(values: number[], label: string): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} ids must be positive integers.`);
    if (!seen.has(value)) result.push(value);
    seen.add(value);
  }
  return result;
}

function scopesOverlap(left: string, right: string): boolean {
  if (left === "**" || right === "**") return true;
  const leftPrefix = staticPrefix(left);
  const rightPrefix = staticPrefix(right);
  if (!leftPrefix || !rightPrefix) return true;
  return leftPrefix === rightPrefix
    || leftPrefix.startsWith(`${rightPrefix}/`)
    || rightPrefix.startsWith(`${leftPrefix}/`);
}

function staticPrefix(scope: string): string {
  return scope.split("/").filter((segment) => !/[?*\[]/.test(segment)).join("/");
}
