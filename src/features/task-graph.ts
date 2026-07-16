export type FeatureTaskParallelMode = "serial" | "parallel";

export type FeatureTaskContractInput = {
  taskId: number;
  objective?: string;
  acceptanceCriteria?: string[];
  excludedScope?: string[];
  mutationScope?: string[];
  dependsOnTaskIds?: number[];
  parallelMode?: FeatureTaskParallelMode;
};

export type FeatureTaskContract = {
  objective: string;
  acceptanceCriteria: string[];
  excludedScope: string[];
  mutationScope: string[];
  dependsOnTaskIds: number[];
  parallelMode: FeatureTaskParallelMode;
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
    contracts.set(taskId, {
      objective,
      acceptanceCriteria,
      excludedScope,
      mutationScope,
      dependsOnTaskIds,
      parallelMode
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
    parallelMode: "serial"
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
