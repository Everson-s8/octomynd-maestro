import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/agents/registry.js";
import { AgentProvider } from "../src/agents/types.js";
import { MaestroConfig } from "../src/config.js";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { createDashboardServer, DashboardServerOptions } from "../src/dashboard/server.js";
import { buildDashboardSnapshot } from "../src/dashboard/snapshot.js";
import { GoalCoordinator } from "../src/goals/coordinator.js";
import { FeatureGitHubGateway, FeaturePullRequestState } from "../src/features/github.js";
import { SkillCatalog } from "../src/skills/catalog.js";
import { SkillVersionStore } from "../src/skills/store.js";
import type { WorkGraphInput } from "../src/work-graphs/types.js";

let tempDir: string;
let projectDir: string;
let database: MaestroDatabase;
let config: MaestroConfig;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-dashboard-"));
  projectDir = path.join(tempDir, "boo-project");
  fs.mkdirSync(projectDir);
  runGit(["init", "-b", "master"], projectDir);
  fs.writeFileSync(path.join(projectDir, "README.md"), "# Boo test\n");
  runGit(["add", "README.md"], projectDir);
  runGit(["-c", "user.name=Maestro Test", "-c", "user.email=maestro@test.local", "commit", "-m", "Initial"], projectDir);

  config = {
    projectName: "maestro-test",
    databasePath: path.join(tempDir, "maestro.db"),
    worktreesPath: path.join(tempDir, "worktrees"),
    execution: {
      rootPath: tempDir,
      worktreesPath: path.join(tempDir, "worktrees"),
      expectedNodeVersion: "20.17.0",
      supportedNodeRange: ">=20.17.0 <21"
    },
    dashboard: { enabled: true, host: "127.0.0.1", port: 4787 },
    autopilot: { enabled: true, pollIntervalMs: 30_000, maxConcurrentGoals: 1 },
    runtime: { tokenEfficient: true },
    workGraph: { adoptionMode: "off" },
    skills: {
      enabled: false,
      catalogPath: path.join(tempDir, "skills"),
      versionsPath: path.join(tempDir, "versions"),
      projectKey: "boo",
      curator: { staleDays: 30, autoArchiveEnabled: false, pollIntervalMs: 21_600_000 }
    },
    telegram: { botToken: "test-token", allowedUserId: "123" }
  };
  database = createDatabase(path.join(tempDir, "maestro.db"));
  database.registerProject({ key: "boo", name: "Boo", path: projectDir, defaultBranch: "master" });
  database.createTask("testar dashboard", "telegram", "boo");
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("dashboard", () => {
  it("distinguishes the dashboard-only process from the full Maestro runtime", async () => {
    const dashboardOnly = createDashboardServer({ config, database, staticRoot: tempDir });
    await new Promise<void>((resolve) => dashboardOnly.listen(0, "127.0.0.1", resolve));
    const dashboardPort = (dashboardOnly.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/health`);
      expect(await response.json()).toMatchObject({ ok: true, runtimeMode: "dashboard" });
    } finally {
      await new Promise<void>((resolve, reject) => dashboardOnly.close(
        (error) => error ? reject(error) : resolve()
      ));
    }

    const fullRuntime = createDashboardServer({
      config,
      database,
      staticRoot: tempDir,
      runtimeMode: "full"
    });
    await new Promise<void>((resolve) => fullRuntime.listen(0, "127.0.0.1", resolve));
    const runtimePort = (fullRuntime.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${runtimePort}/api/health`);
      expect(await response.json()).toMatchObject({ ok: true, runtimeMode: "full" });
    } finally {
      await new Promise<void>((resolve, reject) => fullRuntime.close(
        (error) => error ? reject(error) : resolve()
      ));
    }
  });

  it("serves provider state from the shared Agent Registry snapshot", async () => {
    const server = createDashboardServer({
      config,
      database,
      staticRoot: tempDir,
      runtimeMode: "full",
      agentRegistry: {
        snapshot: async () => [{
          id: "claude",
          label: "Claude",
          capabilities: ["reviewing"],
          health: { state: "ready", detail: "Claude CLI autenticado", checkedAt: new Date().toISOString() },
          state: "cooldown",
          activeCount: 0,
          cooldownUntil: "2026-07-15T12:00:00.000Z",
          detail: "Claude atingiu timeout transitorio.",
          control: { mode: "enabled", fallbackEnabled: true }
        }]
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      const payload = await response.json() as {
        agents: Array<{ id: string; state: string; detail: string }>;
      };

      expect(payload.agents.find((agent) => agent.id === "claude")).toMatchObject({
        state: "attention",
        detail: expect.stringContaining("Cooldown ate 2026-07-15T12:00:00.000Z")
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(
        (error) => error ? reject(error) : resolve()
      ));
    }
  });

  it("persists provider controls and capability routing through the dashboard API", async () => {
    const registry = new AgentRegistry([successfulGoalProvider], undefined, Date.now, database);
    const server = createDashboardServer({
      config,
      database,
      staticRoot: tempDir,
      runtimeMode: "full",
      agentRegistry: registry
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const controlResponse = await fetch(`http://127.0.0.1:${port}/api/provider-policy/providers/codex`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "paused", fallbackEnabled: false })
      });
      expect(controlResponse.status).toBe(200);

      const routingResponse = await fetch(`http://127.0.0.1:${port}/api/provider-policy/capabilities/reviewing`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: ["codex", "claude", "antigravity"], requiredProviderId: "codex" })
      });
      expect(routingResponse.status).toBe(200);

      const policyResponse = await fetch(`http://127.0.0.1:${port}/api/provider-policy`);
      const payload = await policyResponse.json() as { policy: ReturnType<AgentRegistry["policySnapshot"]> };
      expect(payload.policy.controls).toContainEqual(expect.objectContaining({
        providerId: "codex",
        mode: "paused",
        fallbackEnabled: false
      }));
      expect(payload.policy.capabilities.find((item) => item.capability === "reviewing")).toMatchObject({
        order: ["codex", "claude", "antigravity"],
        requiredProviderId: "codex"
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(
        (error) => error ? reject(error) : resolve()
      ));
    }
  });

  it("builds an operational snapshot without private telegram identifiers", () => {
    const snapshot = buildDashboardSnapshot(config, database);

    expect(snapshot.summary.projects).toBe(1);
    expect(snapshot.summary.queuedTasks).toBe(1);
    expect(snapshot.projects[0].key).toBe("boo");
    expect(snapshot.summary.improvementCandidates).toBe(0);
    expect(snapshot.summary.activeGoals).toBe(0);
    expect(snapshot.autopilot).toMatchObject({ enabled: true, state: "idle", queuedTasks: 1 });
    expect(JSON.stringify(snapshot)).not.toContain("test-token");
    expect(JSON.stringify(snapshot)).not.toContain('"123"');
    expect(JSON.stringify(snapshot)).not.toContain(tempDir);

    const task = database.listTasks()[0];
    const fakeSecret = `sk-proj-${"a".repeat(48)}`;
    database.updateTaskWorktree({
      id: task.id,
      status: "planning",
      branchName: `maestro/${fakeSecret}`,
      worktreePath: tempDir
    });
    const protectedSnapshot = JSON.stringify(buildDashboardSnapshot(config, database));
    expect(protectedSnapshot).not.toContain(fakeSecret);
    expect(protectedSnapshot).not.toContain(tempDir);
    expect(protectedSnapshot).not.toContain("worktreePath");
  });

  it("includes the shared redacted Work Graph operational evidence", () => {
    const task = database.listTasks()[0]!;
    const run = database.createGoalRun(task.id);
    const input: WorkGraphInput = {
      runId: run.id,
      objective: `Inspect ${tempDir} and /tmp/private-dashboard`,
      nodes: [{
        key: "research",
        role: "researcher",
        objective: "Inspect bounded evidence.",
        capability: "research",
        outputContract: "Report.",
        mode: "read_only",
        budget: { maxAttempts: 2, deadlineMs: 30_000, outputChars: 2_000 }
      }]
    };
    const graph = database.createWorkGraph(input);
    database.addEvent({
      source: "maestro",
      type: "goal.work_graph_adoption_decision",
      text: "explicit",
      taskId: task.id,
      metadata: {
        runId: run.id,
        mode: "explicit",
        decision: "explicit",
        reason: "explicit_request_recorded",
        executionMode: "work_graph",
        automaticFanOut: false,
        telemetry: { trigger: "task_metadata" }
      }
    });
    database.updateWorkGraphStatus(graph.id, "validated");
    database.updateWorkGraphStatus(graph.id, "running");

    const view = buildDashboardSnapshot(config, database).workGraphs[0]!;
    expect(view).toMatchObject({
      id: graph.id,
      cancellable: true,
      adoption: { decision: "explicit", reason: "explicit_request_recorded" },
      canary: { quality: "pending", attempts: 0, fallbacks: 0 }
    });
    expect(JSON.stringify(view)).not.toContain(tempDir);
    expect(JSON.stringify(view)).not.toContain("/tmp/private-dashboard");
  });

  it("shows the provider currently working on a project", () => {
    const task = database.listTasks()[0];
    database.updateTaskWorktree({
      id: task.id,
      status: "planning",
      branchName: "maestro/status-test",
      worktreePath: projectDir
    });
    const run = database.createGoalRun(task.id);
    database.createGoalStep(run.id, "planning", "codex");

    const snapshot = buildDashboardSnapshot(config, database);

    expect(snapshot.agents.find((agent) => agent.id === "codex")?.state).toBe("working");
    expect(snapshot.projects[0].workingAgents).toEqual(["codex"]);
    expect(snapshot.projects[0].currentWork[0].taskId).toBe(task.id);
  });

  it("shows the latest persisted Environment Doctor report", () => {
    const report = doctorReport();
    database.addEvent({
      source: "maestro",
      type: "environment.doctor",
      text: report.summary,
      metadata: { projectKey: "boo", report }
    });

    const snapshot = buildDashboardSnapshot(config, database);

    expect(snapshot.environments).toEqual([expect.objectContaining({
      projectKey: "boo",
      status: "ready",
      fingerprintId: "0123456789abcdef"
    })]);
  });

  it("serves an Environment Doctor report on demand", async () => {
    const server = createDashboardServer({
      config,
      database,
      staticRoot: tempDir,
      environmentDoctor: { inspectProject: async () => doctorReport() }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/environment/doctor?projectKey=boo`);
      const payload = await response.json() as { report: ReturnType<typeof doctorReport> };
      expect(response.status).toBe(200);
      expect(payload.report.status).toBe("ready");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("shows Feature Plan tasks, eligibility, integration blockers and consolidated PR linkage", () => {
    const first = database.createTask("primeiro bloco", "maestro", "boo");
    const second = database.createTask("segundo bloco", "maestro", "boo");
    database.updateTaskStatus(first.id, "awaiting_human");
    database.updateTaskStatus(second.id, "awaiting_human");
    const plan = database.createFeaturePlan({
      projectKey: "boo",
      objective: "Montar uma Feature consolidada.",
      acceptanceCriteria: ["Somente um Feature PR"],
      taskIds: [first.id, second.id]
    });
    const feature = database.createFeature({
      projectKey: "boo",
      featurePlanId: plan.plan.id,
      name: "Feature consolidada",
      objective: plan.plan.objective,
      branchName: "maestro/feature-plan-1-r1",
      worktreePath: path.join(tempDir, "feature-worktree"),
      pullRequestUrl: "https://github.com/example/boo/pull/9"
    });

    const snapshot = buildDashboardSnapshot(config, database);
    const featurePlan = snapshot.featurePlans.find((item) => item.id === plan.plan.id)!;

    expect(featurePlan.eligible).toBe(true);
    expect(featurePlan.lifecycleStatus).toBe("active");
    expect(featurePlan.blockers).toEqual([]);
    expect(featurePlan.tasks).toEqual([
      expect.objectContaining({ id: first.id, status: "awaiting_human" }),
      expect.objectContaining({ id: second.id, status: "awaiting_human" })
    ]);
    expect(featurePlan.feature).toEqual({
      id: feature.id,
      status: "draft",
      pullRequestUrl: feature.pullRequestUrl
    });
    expect(featurePlan.cancellable).toBe(false);

    database.updateFeature({ id: feature.id, status: "completed" });
    const completedSnapshot = buildDashboardSnapshot(config, database);
    const completedPlan = completedSnapshot.featurePlans.find((item) => item.id === plan.plan.id)!;
    expect(completedPlan.lifecycleStatus).toBe("completed");
    expect(completedPlan.eligible).toBe(false);
    expect(completedSnapshot.summary.plannedFeaturePlans).toBe(0);
  });

  it("preserves explicit Feature Task contracts through the dashboard API", async () => {
    const [first] = database.listTasks();
    const second = database.createTask("segundo bloco paralelo", "dashboard", "boo");
    const server = createDashboardServer({ config, database, staticRoot: tempDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/feature-plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectKey: "boo",
          objective: "Executar blocos independentes com contratos auditaveis.",
          acceptanceCriteria: ["Cada Task respeita seu escopo"],
          taskIds: [first.id, second.id],
          taskContracts: [
            {
              taskId: first.id,
              objective: "Implementar o primeiro bloco isolado.",
              acceptanceCriteria: ["Primeiro bloco validado"],
              mutationScope: ["src/first/**"],
              dependsOnTaskIds: [],
              parallelMode: "parallel"
            },
            {
              taskId: second.id,
              objective: "Implementar o segundo bloco isolado.",
              acceptanceCriteria: ["Segundo bloco validado"],
              excludedScope: ["src/first/**"],
              mutationScope: ["src/second/**"],
              dependsOnTaskIds: [],
              parallelMode: "parallel"
            }
          ]
        })
      });
      const payload = await response.json() as {
        tasks: Array<{ taskId: number; contract: { mutationScope: string[]; parallelMode: string } }>;
      };

      expect(response.status).toBe(201);
      expect(payload.tasks).toEqual([
        expect.objectContaining({
          taskId: first.id,
          contract: expect.objectContaining({ mutationScope: ["src/first/**"], parallelMode: "parallel" })
        }),
        expect.objectContaining({
          taskId: second.id,
          contract: expect.objectContaining({ mutationScope: ["src/second/**"], parallelMode: "parallel" })
        })
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("sanitizes but does not truncate the goal evidence endpoint", async () => {
    const task = database.listTasks()[0];
    database.updateTaskWorktree({
      id: task.id,
      status: "planning",
      branchName: "maestro/evidence-test",
      worktreePath: projectDir
    });
    const run = database.createGoalRun(task.id);
    const step = database.createGoalStep(run.id, "planning", "codex");
    const skillSource = path.join(tempDir, "evidence-skills", "review-feature");
    fs.mkdirSync(skillSource, { recursive: true });
    fs.writeFileSync(path.join(skillSource, "SKILL.md"), [
      "---",
      "name: review-feature",
      "description: Review consolidated Feature evidence.",
      "---",
      "",
      "PRIVATE SKILL INSTRUCTIONS",
      ""
    ].join("\n"));
    const skillMetadata = new SkillCatalog([{
      scope: "repository",
      path: path.dirname(skillSource),
      projectKey: "boo"
    }]).discover().skills[0]!;
    const skillStore = new SkillVersionStore(database, path.join(tempDir, "skill-versions"));
    const registeredSkill = skillStore.register(skillMetadata);
    database.recordSkillEvaluation({
      skillVersionRecordId: registeredSkill.id,
      status: "passed",
      qualityScore: 1,
      durationMs: 2,
      estimatedTokens: 10,
      attempts: 1,
      failures: 0,
      securityPassed: true,
      regressionDetected: false,
      baselineVersionId: null,
      checks: [{ id: "fixture", type: "content", status: "passed", message: "passed" }]
    });
    database.updateSkillVersionStatus(registeredSkill.id, "evaluated");
    database.updateSkillVersionStatus(registeredSkill.id, "approved");
    const activeSkill = database.activateSkillVersion(registeredSkill.id);
    database.pinGoalSkill({
      runId: run.id,
      skillVersionRecordId: activeSkill.id,
      triggerReason: "Final evidence review.",
      invocationMode: "explicit"
    });
    database.recordSkillUsage({
      runId: run.id,
      stepId: step.id,
      skillVersionRecordId: activeSkill.id,
      provider: "codex",
      phase: "planning",
      outcome: "failed",
      durationMs: 5,
      estimatedTokens: 20
    });
    const fakeSecret = `sk-ant-${"z".repeat(24)}`;
    const fullDetail = `Path: C:\\Users\\evers\\Documents\\worktree\nKey: ${fakeSecret}\n${"n".repeat(3_000)}`;
    database.finishGoalStep({
      id: step.id,
      status: "failed",
      summary: "Codex (planning): erro desconhecido.",
      output: fullDetail,
      error: fullDetail,
      durationMs: 5
    });

    const server = createDashboardServer({
      config,
      database,
      staticRoot: tempDir,
      goalCoordinator: new GoalCoordinator(database, new AgentRegistry([successfulGoalProvider]), path.join(tempDir, "runs"))
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/goals/${run.id}`);
      expect(response.status).toBe(200);
      const payload = await response.json() as {
        steps: Array<{ output: string; error: string }>;
        skills: Array<{
          qualifiedName: string;
          versionId: string;
          usage: Array<{ outcome: string; estimatedTokens: number }>;
        }>;
      };
      const [returnedStep] = payload.steps;

      expect(returnedStep.output).not.toContain(fakeSecret);
      expect(returnedStep.output).not.toContain("C:\\Users\\evers");
      expect(returnedStep.output).toContain("n".repeat(3_000));
      expect(returnedStep.error).not.toContain(fakeSecret);
      expect(payload.skills).toEqual([expect.objectContaining({
        qualifiedName: "repository:review-feature",
        versionId: activeSkill.versionId,
        usage: [expect.objectContaining({ outcome: "failed", estimatedTokens: 20 })]
      })]);
      expect(JSON.stringify(payload.skills)).not.toContain("PRIVATE SKILL INSTRUCTIONS");
      expect(JSON.stringify(payload.skills)).not.toContain("snapshotPath");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("serves the dashboard API and creates a queued task", async () => {
    const server = createDashboardServer({
      config,
      database,
      staticRoot: tempDir,
      goalCoordinator: new GoalCoordinator(
        database,
        new AgentRegistry([successfulGoalProvider]),
        path.join(tempDir, "runs")
      ),
      claudeReviewer: async () => ({
        status: "completed",
        content: "Aprovado com ajustes de contraste.",
        error: null,
        durationMs: 42,
        timedOut: false
      })
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const dashboardResponse = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      expect(dashboardResponse.status).toBe(200);
      const dashboard = await dashboardResponse.json() as { summary: { projects: number } };
      expect(dashboard.summary.projects).toBe(1);

      const taskResponse = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey: "boo", text: "nova task visual" })
      });
      expect(taskResponse.status).toBe(201);
      expect(database.listTasksByProject("boo")).toHaveLength(2);
      expect(database.getLastEvent()?.source).toBe("dashboard");
      const taskPayload = await taskResponse.json() as { task: { id: number; source: string } };
      expect(taskPayload.task.source).toBe("dashboard");

      const previewResponse = await fetch(`http://127.0.0.1:${port}/api/work-intake/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey: "boo", objective: "Refatorar componente de busca" })
      });
      expect(previewResponse.status).toBe(200);
      const previewData = await previewResponse.json() as { decision: { classification: string }; explanation: string };
      expect(previewData.decision.classification).toBe("direct_task");
      expect(previewData.explanation).toContain("Tarefa Direta");

      const intakeResponse = await fetch(`http://127.0.0.1:${port}/api/work-intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey: "boo", objective: "Refatorar componente de busca" })
      });
      expect([200, 201]).toContain(intakeResponse.status);
      const intakeData = await intakeResponse.json() as { status: string; createdType: string; explanation: string };
      expect(intakeData.explanation).toBeDefined();
      expect(database.getTask(taskPayload.task.id).source).toBe("dashboard");

      const disposableResponse = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey: "boo", text: "task descartavel" })
      });
      const disposable = await disposableResponse.json() as { task: { id: number } };
      const deleteResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/${disposable.task.id}`, {
        method: "DELETE"
      });
      expect(deleteResponse.status).toBe(200);
      expect(() => database.getTask(disposable.task.id)).toThrow("not found");

      const createdTask = database.listTasksByProject("boo")[0];
      const prepareResponse = await fetch(
        `http://127.0.0.1:${port}/api/tasks/${createdTask.id}/prepare`,
        { method: "POST" }
      );
      expect(prepareResponse.status).toBe(200);
      const preparedTask = database.getTask(createdTask.id);
      expect(preparedTask.status).toBe("planning");
      expect(preparedTask.worktreePath).toContain(path.join("worktrees", "boo"));
      expect(fs.existsSync(preparedTask.worktreePath!)).toBe(true);

      const reviewResponse = await fetch(
        `http://127.0.0.1:${port}/api/tasks/${createdTask.id}/reviews/claude`,
        { method: "POST" }
      );
      expect(reviewResponse.status).toBe(201);
      expect(database.listTaskReviews(createdTask.id)[0].content).toContain("contraste");

      const reviewsResponse = await fetch(
        `http://127.0.0.1:${port}/api/tasks/${createdTask.id}/reviews`
      );
      expect(reviewsResponse.status).toBe(200);
      const reviewsPayload = await reviewsResponse.json() as { reviews: Array<{ provider: string }> };
      expect(reviewsPayload.reviews[0].provider).toBe("claude");
      expect(database.getLastEvent()?.type).toBe("task.reviewed");

      const improvementResponse = await fetch(`http://127.0.0.1:${port}/api/improvements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "integration",
          title: "Harden Telegram delivery retries",
          rationale: "Two task traces show the same transient failure.",
          proposedChange: "Add a bounded retry policy with an auditable failure event.",
          evidence: ["task:3", "event:12"],
          risk: "medium"
        })
      });
      expect(improvementResponse.status).toBe(201);
      const improvementPayload = await improvementResponse.json() as {
        improvement: { id: number; status: string };
      };
      expect(improvementPayload.improvement.status).toBe("candidate");

      const decisionResponse = await fetch(
        `http://127.0.0.1:${port}/api/improvements/${improvementPayload.improvement.id}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "approved", decisionNote: "Implement with tests." })
        }
      );
      expect(decisionResponse.status).toBe(200);
      const approvedImprovement = database.getImprovementProposal(improvementPayload.improvement.id);
      expect(approvedImprovement.status).toBe("approved");
      expect(approvedImprovement.taskId).not.toBeNull();
      expect(approvedImprovement.featurePlanId).not.toBeNull();
      expect(database.getLastEvent()?.type).toBe("improvement.activated_as_feature_plan");

      const goalResponse = await fetch(
        `http://127.0.0.1:${port}/api/tasks/${createdTask.id}/goal`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ maxSteps: 8 })
        }
      );
      expect(goalResponse.status).toBe(202);
      const goalPayload = await goalResponse.json() as { run: { id: number } };
      await waitFor(() => database.getGoalRun(goalPayload.run.id).status !== "running");
      expect(database.getGoalRun(goalPayload.run.id).status).toBe("completed");
      expect(database.getTask(createdTask.id).status).toBe("done");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 15_000);

  it("serves the dashboard snapshot without waiting for slow coordinators", async () => {
    let reviewReconcileCalls = 0;
    let featureReconcileCalls = 0;
    const slowReviewCoordinator = {
      reconcile: async () => {
        reviewReconcileCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return 1;
      }
    } as unknown as NonNullable<DashboardServerOptions["reviewCoordinator"]>;
    const slowFeatureCoordinator: NonNullable<DashboardServerOptions["featureCoordinator"]> = {
      reconcile: async () => {
        featureReconcileCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return 1;
      }
    };
    const server = createDashboardServer({
      config,
      database,
      staticRoot: tempDir,
      reviewCoordinator: slowReviewCoordinator,
      featureCoordinator: slowFeatureCoordinator
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const startedAt = performance.now();
      const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      const elapsedMs = performance.now() - startedAt;
      const dashboard = await response.json() as { summary: { projects: number } };

      expect(response.status).toBe(200);
      expect(dashboard.summary.projects).toBe(1);
      expect(elapsedMs).toBeLessThan(500);
      expect(reviewReconcileCalls).toBe(0);
      expect(featureReconcileCalls).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("maps typed application command errors to HTTP status codes", async () => {
    const server = createDashboardServer({ config, database, staticRoot: tempDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const notFoundResponse = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey: "does-not-exist", text: "task orfa" })
      });
      expect(notFoundResponse.status).toBe(404);

      const task = database.listTasks()[0];
      const prepareResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/prepare`, { method: "POST" });
      expect(prepareResponse.status).toBe(200);

      const conflictResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/prepare`, { method: "POST" });
      expect(conflictResponse.status).toBe(409);
      const conflictPayload = await conflictResponse.json() as { error: string; details: string[] };
      expect(conflictPayload.details.join(" ")).toContain("already has a worktree");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("cancels a pre-merge Feature through the dashboard and closes its consolidated PR", async () => {
    const github = new FakeFeatureGitHubGateway();
    const feature = database.createFeature({
      projectKey: "boo",
      name: "Feature cancelavel",
      objective: "Cancelar com auditoria.",
      branchName: github.state.headRefName,
      worktreePath: path.join(tempDir, "feature-cancelavel"),
      pullRequestUrl: github.state.url
    });
    const server = createDashboardServer({ config, database, staticRoot: tempDir, featureGithub: github });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/features/${feature.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Mudanca de prioridade." })
      });

      expect(response.status).toBe(200);
      expect(database.getFeature(feature.id)).toMatchObject({
        status: "cancelled",
        cancelReason: "Mudanca de prioridade."
      });
      expect(github.closed).toEqual([github.state.url]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

function runGit(args: string[], cwd: string) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "git test setup failed");
  }
}

const successfulGoalProvider: AgentProvider = {
  id: "codex",
  label: "Codex test",
  capabilities: new Set(["planning", "coding", "testing", "reviewing"]),
  health: async () => ({ state: "ready", detail: "test", checkedAt: new Date().toISOString() }),
  execute: async (request) => ({
    outcome: "completed",
    summary: `${request.phase} completed`,
    output: "ok",
    error: null,
    durationMs: 1,
    retryable: false
  })
};

function doctorReport() {
  return {
    status: "ready" as const,
    summary: "Execution environment ready.",
    recommendedAction: "No action required.",
    checkedAt: new Date().toISOString(),
    projectKey: "boo",
    taskId: null,
    fingerprintId: "0123456789abcdef",
    requiredCapabilities: ["planning" as const],
    checks: [{
      name: "execution_paths" as const,
      status: "passed" as const,
      summary: "safe",
      evidence: []
    }]
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for goal completion.");
}

class FakeFeatureGitHubGateway implements FeatureGitHubGateway {
  state: FeaturePullRequestState = {
    number: 9,
    title: "Feature cancelavel",
    url: "https://github.com/example/boo/pull/9",
    state: "OPEN",
    isDraft: true,
    mergeable: "MERGEABLE",
    headRefName: "maestro/feature-cancelavel",
    headRepositoryOwner: "example",
    headRepositoryName: "boo",
    baseRefName: "master",
    headSha: "b".repeat(40),
    checks: []
  };
  readonly closed: string[] = [];

  async inspect(): Promise<FeaturePullRequestState> { return { ...this.state, checks: [...this.state.checks] }; }
  async merge(): Promise<void> {}
  async markDraft(): Promise<void> {}
  async close(url: string): Promise<void> { this.closed.push(url); this.state = { ...this.state, state: "CLOSED" }; }
  async closeSuperseded(): Promise<void> {}
  async deleteHeadBranch(): Promise<void> {}
  async closeIssue(): Promise<void> {}
}
