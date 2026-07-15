import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/agents/registry.js";
import { AgentExecutionRequest, AgentProvider } from "../src/agents/types.js";
import { createDatabase } from "../src/db.js";
import {
  FeatureBlockedEvent,
  FeatureCompletion,
  FeatureCoordinator
} from "../src/features/coordinator.js";
import {
  FeatureGitHubGateway,
  FeaturePullRequestState,
  featureChecksPassed
} from "../src/features/github.js";
import { formatFeatureCompletionNotification } from "../src/telegram/notifications.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("feature completion protocol", () => {
  it("persists a Feature and its Work PR associations", () => {
    const fixture = createFixture("completed");

    expect(fixture.database.getFeature(fixture.feature.id).name).toBe("Maestro Reliability Foundation");
    expect(fixture.database.listFeatureItems(fixture.feature.id)).toEqual([
      expect.objectContaining({
        taskId: fixture.task.id,
        pullRequestUrl: "https://github.com/example/project/pull/4",
        branchName: "maestro/task-4",
        status: "included"
      })
    ]);
    fixture.database.close();
  });

  it("requires successful checks before invoking the final reviewer", async () => {
    const fixture = createFixture("completed");
    fixture.github.state.checks = [];
    const coordinator = new FeatureCoordinator(
      fixture.database,
      new AgentRegistry([fixture.provider]),
      path.join(fixture.tempDir, "artifacts"),
      fixture.github
    );

    await coordinator.reconcile();

    expect(fixture.database.getFeature(fixture.feature.id).status).toBe("waiting_checks");
    expect(fixture.provider.requests).toHaveLength(0);
    expect(fixture.github.merges).toHaveLength(0);
    fixture.database.close();
  });

  it("waits until GitHub confirms the Feature PR is mergeable", async () => {
    const fixture = createFixture("completed");
    fixture.github.state.mergeable = "UNKNOWN";
    const coordinator = new FeatureCoordinator(
      fixture.database,
      new AgentRegistry([fixture.provider]),
      path.join(fixture.tempDir, "artifacts"),
      fixture.github
    );

    await coordinator.reconcile();

    expect(fixture.database.getFeature(fixture.feature.id).status).toBe("waiting_checks");
    expect(fixture.provider.requests).toHaveLength(0);
    expect(fixture.github.merges).toHaveLength(0);
    fixture.database.close();
  });

  it("reviews the exact head, merges it, closes Work PRs and completes their Tasks", async () => {
    const fixture = createFixture("completed");
    let notification: FeatureCompletion | null = null;
    const coordinator = new FeatureCoordinator(
      fixture.database,
      new AgentRegistry([fixture.provider]),
      path.join(fixture.tempDir, "artifacts"),
      fixture.github,
      async (completion) => { notification = completion; }
    );

    await coordinator.reconcile();

    const feature = fixture.database.getFeature(fixture.feature.id);
    expect(feature.status).toBe("completed");
    expect(feature.reviewerProvider).toBe("claude");
    expect(feature.reviewedHeadSha).toBe("abc123");
    expect(fixture.github.merges).toEqual([{
      url: feature.pullRequestUrl,
      expectedHeadSha: "abc123"
    }]);
    expect(fixture.github.closed).toEqual([{
      url: "https://github.com/example/project/pull/4",
      featureUrl: feature.pullRequestUrl
    }]);
    expect(fixture.github.closedIssues).toEqual([
      { issueNumber: 36, comment: expect.stringContaining(feature.pullRequestUrl) },
      { issueNumber: 35, comment: expect.stringContaining(feature.pullRequestUrl) }
    ]);
    expect(fixture.github.deleted).toEqual([
      "https://github.com/example/project/pull/4",
      feature.pullRequestUrl
    ]);
    expect(fixture.database.getTask(fixture.task.id).status).toBe("done");
    expect(fixture.database.listFeatureItems(feature.id)[0].status).toBe("completed");
    expect(notification).not.toBeNull();
    expect(formatFeatureCompletionNotification(notification!)).toContain("Feature concluida");
    fixture.database.close();
  });

  it("returns the Feature PR to draft when final review requests changes", async () => {
    const fixture = createFixture("changes_requested");
    const coordinator = new FeatureCoordinator(
      fixture.database,
      new AgentRegistry([fixture.provider]),
      path.join(fixture.tempDir, "artifacts"),
      fixture.github
    );

    await coordinator.reconcile();

    expect(fixture.database.getFeature(fixture.feature.id).status).toBe("changes_requested");
    expect(fixture.github.markedDraft).toBe(true);
    expect(fixture.github.merges).toHaveLength(0);
    expect(fixture.database.getTask(fixture.task.id).status).toBe("queued");
    fixture.database.close();
  });

  it("retries Work PR closure before announcing Feature completion", async () => {
    const fixture = createFixture("completed");
    fixture.github.closeFailuresRemaining = 1;
    let notifications = 0;
    const coordinator = new FeatureCoordinator(
      fixture.database,
      new AgentRegistry([fixture.provider]),
      path.join(fixture.tempDir, "artifacts"),
      fixture.github,
      async () => { notifications += 1; }
    );

    await coordinator.reconcile();

    expect(fixture.database.getFeature(fixture.feature.id).status).toBe("merging");
    expect(fixture.database.getTask(fixture.task.id).status).toBe("queued");
    expect(notifications).toBe(0);

    await coordinator.reconcile();

    expect(fixture.database.getFeature(fixture.feature.id).status).toBe("completed");
    expect(fixture.database.getTask(fixture.task.id).status).toBe("done");
    expect(notifications).toBe(1);
    fixture.database.close();
  });

  it("retries GitHub issue closure before announcing Feature completion", async () => {
    const fixture = createFixture("completed");
    fixture.github.issueCloseFailuresRemaining = 1;
    let notifications = 0;
    const coordinator = new FeatureCoordinator(
      fixture.database,
      new AgentRegistry([fixture.provider]),
      path.join(fixture.tempDir, "artifacts"),
      fixture.github,
      async () => { notifications += 1; }
    );

    await coordinator.reconcile();

    expect(fixture.database.getFeature(fixture.feature.id).status).toBe("merging");
    expect(fixture.database.getTask(fixture.task.id).status).toBe("queued");
    expect(notifications).toBe(0);

    await coordinator.reconcile();

    expect(fixture.database.getFeature(fixture.feature.id).status).toBe("completed");
    expect(fixture.database.getTask(fixture.task.id).status).toBe("done");
    expect(fixture.github.closedIssues.map((entry) => entry.issueNumber)).toEqual([36, 35]);
    expect(notifications).toBe(1);
    fixture.database.close();
  });

  it("notifies a merge conflict once and returns the Feature PR to Draft", async () => {
    const fixture = createFixture("completed");
    fixture.github.state.mergeable = "CONFLICTING";
    const blocked: FeatureBlockedEvent[] = [];
    const coordinator = new FeatureCoordinator(
      fixture.database,
      new AgentRegistry([fixture.provider]),
      path.join(fixture.tempDir, "artifacts"),
      fixture.github,
      undefined,
      async (event) => { blocked.push(event); }
    );

    await coordinator.reconcile();
    await coordinator.reconcile();

    expect(blocked.map((event) => event.reason)).toEqual(["conflict"]);
    expect(fixture.github.markedDraft).toBe(true);
    expect(fixture.github.merges).toHaveLength(0);
    fixture.database.close();
  });

  it("notifies waiting_provider only on the transition into that blocker", async () => {
    const fixture = createFixture("completed");
    const blocked: FeatureBlockedEvent[] = [];
    const coordinator = new FeatureCoordinator(
      fixture.database,
      new AgentRegistry([]),
      path.join(fixture.tempDir, "artifacts"),
      fixture.github,
      undefined,
      async (event) => { blocked.push(event); }
    );

    await coordinator.reconcile();
    await coordinator.reconcile();

    expect(blocked.map((event) => event.reason)).toEqual(["waiting_provider"]);
    expect(fixture.database.getFeature(fixture.feature.id).status).toBe("waiting_provider");
    fixture.database.close();
  });

  it("does not reconcile a cancelled Feature", async () => {
    const fixture = createFixture("completed");
    fixture.database.cancelFeature(fixture.feature.id, "Cancelled before review.");
    const coordinator = new FeatureCoordinator(
      fixture.database,
      new AgentRegistry([fixture.provider]),
      path.join(fixture.tempDir, "artifacts"),
      fixture.github
    );

    await coordinator.reconcile();

    expect(fixture.github.inspectCalls).toBe(0);
    expect(fixture.provider.requests).toHaveLength(0);
    fixture.database.close();
  });

  it("does not merge when the Feature is cancelled while final review is running", async () => {
    const fixture = createFixture("completed");
    const cancellingProvider: AgentProvider = {
      id: "claude",
      label: "Claude",
      capabilities: new Set(["reviewing"] as const),
      health: async () => ({ state: "ready", detail: "test", checkedAt: new Date().toISOString() }),
      execute: async () => {
        fixture.database.cancelFeature(fixture.feature.id, "Cancelled during review.");
        return {
          outcome: "completed",
          summary: "Approved before cancellation was observed.",
          output: "Approved.",
          error: null,
          durationMs: 1,
          retryable: false
        };
      }
    };
    const coordinator = new FeatureCoordinator(
      fixture.database,
      new AgentRegistry([cancellingProvider]),
      path.join(fixture.tempDir, "artifacts"),
      fixture.github
    );

    await coordinator.reconcile();

    expect(fixture.database.getFeature(fixture.feature.id).status).toBe("cancelled");
    expect(fixture.github.merges).toHaveLength(0);
    fixture.database.close();
  });
});

describe("feature check gate", () => {
  it("fails closed for absent, pending or failed checks", () => {
    const state = pullRequestState();
    expect(featureChecksPassed({ ...state, checks: [] })).toBe(false);
    expect(featureChecksPassed({
      ...state,
      checks: [{ name: "CI", status: "IN_PROGRESS", conclusion: "" }]
    })).toBe(false);
    expect(featureChecksPassed({
      ...state,
      checks: [{ name: "CI", status: "COMPLETED", conclusion: "FAILURE" }]
    })).toBe(false);
    expect(featureChecksPassed(state)).toBe(true);
  });
});

function createFixture(outcome: "completed" | "changes_requested") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-feature-"));
  tempDirs.push(tempDir);
  const projectPath = path.join(tempDir, "project");
  const featureWorktree = path.join(tempDir, "feature-worktree");
  fs.mkdirSync(projectPath);
  fs.mkdirSync(featureWorktree);
  const database = createDatabase(path.join(tempDir, "maestro.db"));
  database.registerProject({ key: "maestro", name: "Octomynd Maestro", path: projectPath });
  const task = database.createTask("harden safety gate", "maestro", "maestro");
  const featurePlan = database.createFeaturePlan({
    projectKey: "maestro",
    objective: "Integrate safety, lifecycle, provider fallback and CI.",
    acceptanceCriteria: ["The consolidated Feature closes its tracked GitHub issues"],
    taskIds: [task.id],
    featureIssueNumber: 35,
    taskIssueNumbers: { [task.id]: 36 }
  });
  const feature = database.createFeature({
    featurePlanId: featurePlan.plan.id,
    projectKey: "maestro",
    name: "Maestro Reliability Foundation",
    objective: "Integrate safety, lifecycle, provider fallback and CI.",
    branchName: "maestro/feature-reliability",
    worktreePath: featureWorktree,
    pullRequestUrl: "https://github.com/example/project/pull/5"
  });
  database.addFeatureItem({
    featureId: feature.id,
    taskId: task.id,
    pullRequestUrl: "https://github.com/example/project/pull/4",
    branchName: "maestro/task-4"
  });
  return {
    tempDir,
    database,
    task,
    feature,
    provider: new FakeReviewProvider(outcome),
    github: new FakeFeatureGitHubGateway()
  };
}

class FakeReviewProvider implements AgentProvider {
  readonly id = "claude" as const;
  readonly label = "Claude";
  readonly capabilities = new Set(["reviewing"] as const);
  readonly requests: AgentExecutionRequest[] = [];

  constructor(private readonly outcome: "completed" | "changes_requested") {}

  async health() {
    return { state: "ready" as const, detail: "test", checkedAt: new Date().toISOString() };
  }

  async execute(request: AgentExecutionRequest) {
    this.requests.push(request);
    return {
      outcome: this.outcome,
      summary: this.outcome === "completed" ? "Final review approved." : "Blocking regression found.",
      output: this.outcome === "completed" ? "Approved after complete diff review." : "Changes requested: fix regression.",
      error: null,
      durationMs: 5,
      retryable: false
    };
  }
}

class FakeFeatureGitHubGateway implements FeatureGitHubGateway {
  state = pullRequestState();
  readonly merges: Array<{ url: string; expectedHeadSha: string }> = [];
  readonly closed: Array<{ url: string; featureUrl: string }> = [];
  readonly closedIssues: Array<{ issueNumber: number; comment: string }> = [];
  readonly deleted: string[] = [];
  markedDraft = false;
  closeFailuresRemaining = 0;
  issueCloseFailuresRemaining = 0;
  inspectCalls = 0;

  async inspect(url: string): Promise<FeaturePullRequestState> {
    this.inspectCalls += 1;
    if (url === this.state.url) return { ...this.state, checks: [...this.state.checks] };
    return {
      ...this.state,
      number: 4,
      url,
      title: "Work PR",
      headRefName: "maestro/task-4"
    };
  }

  async merge(url: string, expectedHeadSha: string): Promise<void> {
    this.merges.push({ url, expectedHeadSha });
    this.state = { ...this.state, state: "MERGED", isDraft: false };
  }

  async markDraft(): Promise<void> {
    this.markedDraft = true;
    this.state = { ...this.state, isDraft: true };
  }

  async close(url: string, comment: string): Promise<void> {
    this.closed.push({ url, featureUrl: comment });
  }

  async closeSuperseded(url: string, featureUrl: string): Promise<void> {
    if (this.closeFailuresRemaining > 0) {
      this.closeFailuresRemaining -= 1;
      throw new Error("temporary GitHub close failure");
    }
    this.closed.push({ url, featureUrl });
  }

  async deleteHeadBranch(url: string): Promise<void> {
    this.deleted.push(url);
  }

  async closeIssue(_url: string, issueNumber: number, comment: string): Promise<void> {
    if (this.issueCloseFailuresRemaining > 0) {
      this.issueCloseFailuresRemaining -= 1;
      throw new Error("temporary GitHub issue close failure");
    }
    if (!this.closedIssues.some((entry) => entry.issueNumber === issueNumber)) {
      this.closedIssues.push({ issueNumber, comment });
    }
  }
}

function pullRequestState(): FeaturePullRequestState {
  return {
    number: 5,
    title: "Feature: Maestro Reliability Foundation",
    url: "https://github.com/example/project/pull/5",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    headRefName: "maestro/feature-reliability",
    headRepositoryOwner: "example",
    headRepositoryName: "project",
    baseRefName: "main",
    headSha: "abc123",
    checks: [{ name: "CI", status: "COMPLETED", conclusion: "SUCCESS" }]
  };
}
