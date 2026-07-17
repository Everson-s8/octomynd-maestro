import type { FeaturePlanDetails, FeaturePlanTaskRecord, MaestroDatabase, TaskRecord } from "../db.js";
import { featureTaskContractsConflict, transitiveDependencyIds } from "./task-graph.js";

export type FeatureTaskReadiness =
  | { state: "ready"; featurePlan: FeaturePlanDetails | null }
  | { state: "waiting"; reason: string; featurePlan: FeaturePlanDetails | null }
  | { state: "blocked"; reason: string; featurePlan: FeaturePlanDetails };

const SATISFIED_DEPENDENCY_STATES = new Set(["awaiting_human", "ready_to_merge", "done"]);
const FAILED_DEPENDENCY_STATES = new Set(["blocked", "failed", "cancelled", "rejected"]);

export function evaluateFeatureTaskReadiness(
  database: MaestroDatabase,
  task: TaskRecord,
  activeTasks: TaskRecord[]
): FeatureTaskReadiness {
  const featurePlan = database.findFeaturePlanDetailsByTask(task.id);
  if (!featurePlan) {
    const occupied = activeTasks.find((candidate) => candidate.projectKey === task.projectKey);
    return occupied
      ? { state: "waiting", reason: `project_busy_by_task_${occupied.id}`, featurePlan: null }
      : { state: "ready", featurePlan: null };
  }

  const node = requirePlanTask(featurePlan, task.id);
  for (const dependencyId of transitiveDependencyIds(featurePlan.tasks, task.id)) {
    const dependency = database.getTask(dependencyId);
    if (FAILED_DEPENDENCY_STATES.has(dependency.status)) {
      return {
        state: "blocked",
        reason: `dependency_task_${dependency.id}_${dependency.status}`,
        featurePlan
      };
    }
    if (!SATISFIED_DEPENDENCY_STATES.has(dependency.status)) {
      return {
        state: "waiting",
        reason: `dependency_task_${dependency.id}_${dependency.status}`,
        featurePlan
      };
    }
  }

  for (const activeTask of activeTasks) {
    if (activeTask.id === task.id || activeTask.projectKey !== task.projectKey) continue;
    const activePlan = database.findFeaturePlanDetailsByTask(activeTask.id);
    if (!activePlan || activePlan.plan.id !== featurePlan.plan.id) {
      return {
        state: "waiting",
        reason: `project_busy_by_task_${activeTask.id}`,
        featurePlan
      };
    }
    const activeNode = requirePlanTask(activePlan, activeTask.id);
    if (featureTaskContractsConflict(node.contract, activeNode.contract)) {
      return {
        state: "waiting",
        reason: `mutation_scope_conflict_with_task_${activeTask.id}`,
        featurePlan
      };
    }
  }

  return { state: "ready", featurePlan };
}

function requirePlanTask(details: FeaturePlanDetails, taskId: number): FeaturePlanTaskRecord {
  const task = details.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error(`Task #${taskId} is missing from Feature Plan #${details.plan.id}.`);
  return task;
}
