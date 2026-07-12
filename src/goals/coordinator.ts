import { AgentRegistry } from "../agents/registry.js";
import { GoalRunRecord, MaestroDatabase } from "../db.js";
import { runTaskGoal } from "./runner.js";

export class GoalCoordinator {
  private readonly active = new Map<number, Promise<GoalRunRecord>>();

  constructor(
    private readonly database: MaestroDatabase,
    private readonly registry: AgentRegistry,
    private readonly artifactsRoot: string
  ) {}

  start(taskId: number, maxSteps = 12): GoalRunRecord {
    if (this.active.has(taskId)) {
      throw new Error(`Task #${taskId} already has a goal running in this process.`);
    }

    const task = this.database.getTask(taskId);
    if (!task.projectKey) throw new Error(`Task #${taskId} has no project.`);
    if (!task.worktreePath) throw new Error(`Task #${taskId} must be prepared before starting a goal.`);
    const run = this.database.createGoalRun(taskId, maxSteps);

    const promise = runTaskGoal(this.database, this.registry, taskId, {
      artifactsRoot: this.artifactsRoot,
      maxSteps,
      existingRun: run
    });
    this.active.set(taskId, promise);
    void promise.then(
      () => this.active.delete(taskId),
      () => this.active.delete(taskId)
    );
    return run;
  }

  isActive(taskId: number): boolean {
    return this.active.has(taskId);
  }
}
