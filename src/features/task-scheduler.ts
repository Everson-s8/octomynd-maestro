import type { FeaturePlanDetails, FeaturePlanTaskRecord, MaestroDatabase, TaskRecord } from "../db.js";
import { featureTaskContractsConflict, transitiveDependencyIds } from "./task-graph.js";

export type FeatureTaskReadiness =
  | { state: "ready"; reason?: undefined; featurePlan: FeaturePlanDetails | null }
  | { state: "waiting"; reason: string; featurePlan: FeaturePlanDetails | null }
  | { state: "blocked"; reason: string; featurePlan: FeaturePlanDetails };

const SATISFIED_DEPENDENCY_STATES = new Set(["awaiting_human", "ready_to_merge", "done"]);
const FAILED_DEPENDENCY_STATES = new Set(["blocked", "failed", "cancelled", "rejected"]);

export function evaluateFeatureTaskReadiness(
  database: MaestroDatabase,
  task: TaskRecord,
  activeTasks: TaskRecord[]
): FeatureTaskReadiness {
  let featurePlan = database.findFeaturePlanDetailsByTask(task.id);
  if (!featurePlan) {
    const occupied = activeTasks.find((candidate) => candidate.projectKey === task.projectKey);
    return occupied
      ? { state: "waiting", reason: `project_busy_by_task_${occupied.id}`, featurePlan: null }
      : { state: "ready", featurePlan: null };
  }

  if (featurePlan.plan.isPaused) {
    return {
      state: "waiting",
      reason: featurePlan.plan.pauseReason
        ? `feature_plan_paused_${featurePlan.plan.pauseReason}`
        : "feature_plan_paused",
      featurePlan
    };
  }

  if (featurePlan.plan.status === "blocked" || featurePlan.plan.status === "cancelled") {
    return {
      state: "blocked",
      reason: `feature_plan_${featurePlan.plan.status}`,
      featurePlan
    };
  }

  if (featurePlan.plan.status === "queued") {
    const eligibility = database.evaluateFeaturePlanEligibility(featurePlan.plan.id);
    if (!eligibility.eligible) {
      return {
        state: "waiting",
        reason: eligibility.reason,
        featurePlan
      };
    }

    try {
      database.admitFeaturePlan(featurePlan.plan.id);
      database.addEvent({
        source: "maestro",
        type: "feature_plan.admitted",
        text: `Feature Plan #${featurePlan.plan.id} admitted to project writer lease.`,
        metadata: { featurePlanId: featurePlan.plan.id }
      });
      const updated = database.findFeaturePlanDetailsByTask(task.id);
      if (updated) featurePlan = updated;
    } catch (error) {
      const updated = database.findFeaturePlanDetailsByTask(task.id);
      if (!updated || !["admitted", "active"].includes(updated.plan.status)) throw error;
      featurePlan = updated;
    }
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

  if (featurePlan.plan.status === "admitted") {
    try {
      database.updateFeaturePlanQueueStatus(featurePlan.plan.id, "active", "Task implementation started");
      const updated = database.findFeaturePlanDetailsByTask(task.id);
      if (updated) featurePlan = updated;
    } catch (error) {
      const updated = database.findFeaturePlanDetailsByTask(task.id);
      if (!updated || updated.plan.status !== "active") throw error;
      featurePlan = updated;
    }
  }

  return { state: "ready", featurePlan };
}

export function revalidateQueuedFeaturePlans(
  database: MaestroDatabase,
  projectKey?: string
): FeaturePlanDetails[] {
  const admittedPlans: FeaturePlanDetails[] = [];
  const queue = database.listFeaturePlanQueue(projectKey);

  for (const details of queue) {
    const { plan } = details;

    const dependencies = database.listFeaturePlanDependencies(plan.id);
    let hasCancelledDep = false;
    let cancelledDepId: number | null = null;
    let hasBlockedDep = false;
    let blockedDepId: number | null = null;

    for (const dep of dependencies) {
      const depPlan = database.getFeaturePlan(dep.dependsOnFeaturePlanId);
      if (depPlan.status === "cancelled") {
        hasCancelledDep = true;
        cancelledDepId = depPlan.id;
        break;
      }
      if (depPlan.status === "blocked") {
        hasBlockedDep = true;
        blockedDepId = depPlan.id;
      }
    }

    if (hasCancelledDep) {
      if (plan.status === "queued" || plan.status === "admitted") {
        database.updateFeaturePlanQueueStatus(
          plan.id,
          "blocked",
          `predecessor_feature_plan_${cancelledDepId}_cancelled`
        );
        database.addEvent({
          source: "maestro",
          type: "feature_plan.status_changed",
          text: `Feature Plan #${plan.id} blocked by cancelled predecessor.`,
          metadata: {
            featurePlanId: plan.id,
            status: "blocked",
            reason: `predecessor_feature_plan_${cancelledDepId}_cancelled`
          }
        });
      }
      continue;
    }

    if (hasBlockedDep) {
      if (plan.status === "queued" || plan.status === "admitted") {
        database.updateFeaturePlanQueueStatus(
          plan.id,
          "blocked",
          `predecessor_feature_plan_${blockedDepId}_blocked`
        );
        database.addEvent({
          source: "maestro",
          type: "feature_plan.status_changed",
          text: `Feature Plan #${plan.id} blocked by blocked predecessor.`,
          metadata: {
            featurePlanId: plan.id,
            status: "blocked",
            reason: `predecessor_feature_plan_${blockedDepId}_blocked`
          }
        });
      }
      continue;
    }

    if (plan.status === "blocked" && plan.blockedReason?.startsWith("predecessor_feature_plan_")) {
      database.updateFeaturePlanQueueStatus(plan.id, "queued", null);
    }

    const currentPlan = database.getFeaturePlan(plan.id);
    if (currentPlan.status === "queued") {
      const eligibility = database.evaluateFeaturePlanEligibility(plan.id);
      if (eligibility.eligible) {
        const admitted = database.admitFeaturePlan(plan.id);
        database.addEvent({
          source: "maestro",
          type: "feature_plan.admitted",
          text: `Feature Plan #${plan.id} admitted to project writer lease.`,
          metadata: { featurePlanId: plan.id }
        });
        admittedPlans.push(admitted);
      }
    }
  }

  return admittedPlans;
}

export function revalidateQueuedFeaturePlansWithAudit(
  database: MaestroDatabase,
  trigger: string,
  projectKey?: string
): FeaturePlanDetails[] {
  try {
    return revalidateQueuedFeaturePlans(database, projectKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      database.addEvent({
        source: "maestro",
        type: "feature_plan.revalidation_failed",
        text: `Feature Plan queue revalidation failed during ${trigger}: ${message}`,
        metadata: { trigger, projectKey: projectKey ?? null, error: message }
      });
    } catch (eventError) {
      console.error("Feature Plan queue revalidation and audit persistence failed.", error, eventError);
    }
    return [];
  }
}

function requirePlanTask(details: FeaturePlanDetails, taskId: number): FeaturePlanTaskRecord {
  const task = details.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error(`Task #${taskId} is missing from Feature Plan #${details.plan.id}.`);
  return task;
}
