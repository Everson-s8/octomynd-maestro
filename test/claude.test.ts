import { describe, expect, it } from "vitest";
import { buildClaudeReviewPrompt } from "../src/agents/claude.js";
import { ProjectRecord, TaskRecord } from "../src/db.js";

describe("claude review", () => {
  it("builds a read-only design review prompt with task context", () => {
    const project: ProjectRecord = {
      id: 1,
      key: "maestro",
      name: "Octomynd Maestro",
      path: "C:/repo/maestro",
      defaultBranch: "main",
      createdAt: "now",
      updatedAt: "now"
    };
    const task: TaskRecord = {
      id: 9,
      projectId: 1,
      projectKey: "maestro",
      projectName: project.name,
      text: "revisar a identidade visual",
      status: "planning",
      source: "dashboard",
      branchName: "maestro/task-9-review",
      worktreePath: "C:/worktrees/task-9",
      createdAt: "now",
      updatedAt: "now"
    };

    const prompt = buildClaudeReviewPrompt(task, project);

    expect(prompt).toContain("somente em modo leitura");
    expect(prompt).toContain("Task #9: revisar a identidade visual");
    expect(prompt).toContain("docs/VISUAL_IDENTITY.md");
  });
});
