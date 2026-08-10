import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { ApplicationCommands } from "../src/commands/application-commands.js";
import { classifyWorkIntake, parseOverrideFromText } from "../src/intake/classifier.js";
import { evaluateWorkIntakeClassifier, WORK_INTAKE_EVAL_SUITE } from "../src/intake/evals.js";
import { getWorkIntakeMetrics } from "../src/intake/persistence.js";
import { scanWorktreePathsForSecrets } from "../src/security/secrets.js";

describe("Work Intake Classification System", () => {
  let tempDir: string;
  let dbPath: string;
  let database: MaestroDatabase;
  let commands: ApplicationCommands;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-intake-test-"));
    dbPath = path.join(tempDir, "maestro.db");
    database = createDatabase(dbPath);
    database.registerProject({
      key: "testproj",
      name: "Test Project",
      path: tempDir,
      defaultBranch: "main"
    });
    commands = new ApplicationCommands(database);
  });

  afterEach(() => {
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Classifier Unit Tests & Representative Eval Suite", () => {
    it("runs the full representative evaluation suite with 100% pass rate", () => {
      const report = evaluateWorkIntakeClassifier(WORK_INTAKE_EVAL_SUITE);
      expect(report.total).toBe(8);
      expect(report.passed).toBe(8);
      expect(report.failed).toBe(0);
      expect(report.results.every((res) => res.passed)).toBe(true);
    });

    it("classifies tiny fix requests into single_agent mode", () => {
      const res = classifyWorkIntake({ text: "Fix typo in variable name in index.ts" });
      expect(res.category).toBe("tiny_fix");
      expect(res.decisionMode).toBe("single_agent");
      expect(res.actualMode).toBe("single_agent");
      expect(res.overrideApplied).toBe(false);
    });

    it("classifies documentation requests into single_agent mode", () => {
      const res = classifyWorkIntake({ text: "Update README and user guide documentation" });
      expect(res.category).toBe("documentation");
      expect(res.decisionMode).toBe("single_agent");
      expect(res.actualMode).toBe("single_agent");
    });

    it("classifies audit requests into single_agent mode", () => {
      const res = classifyWorkIntake({ text: "Run security audit and dependency vulnerability review" });
      expect(res.category).toBe("audit");
      expect(res.decisionMode).toBe("single_agent");
      expect(res.actualMode).toBe("single_agent");
    });

    it("classifies multi-deliverable features into feature_plan mode", () => {
      const res = classifyWorkIntake({ text: "Implement billing integration with REST API and DB migration" });
      expect(res.category).toBe("multi_deliverable_feature");
      expect(res.decisionMode).toBe("feature_plan");
      expect(res.actualMode).toBe("feature_plan");
    });

    it("classifies dependent work requests into feature_plan mode", () => {
      const res = classifyWorkIntake({ text: "Add successor task depends on feature plan #5" });
      expect(res.category).toBe("dependent_work");
      expect(res.decisionMode).toBe("feature_plan");
      expect(res.actualMode).toBe("feature_plan");
    });

    it("classifies parallel-safe work into work_graph mode", () => {
      const res = classifyWorkIntake({ text: "Add independent worker for background logger with parallel-safe execution" });
      expect(res.category).toBe("parallel_safe_work");
      expect(res.decisionMode).toBe("work_graph");
      expect(res.actualMode).toBe("work_graph");
    });

    it("classifies ambiguous requests into needs_clarification mode", () => {
      const res = classifyWorkIntake({ text: "fix it" });
      expect(res.category).toBe("ambiguous_request");
      expect(res.decisionMode).toBe("needs_clarification");
      expect(res.actualMode).toBe("needs_clarification");
    });

    it("parses inline explicit override flags", () => {
      const parsed = parseOverrideFromText("Refactor module --mode=single_agent");
      expect(parsed.cleanedText).toBe("Refactor module");
      expect(parsed.overrideMode).toBe("single_agent");
    });

    it("handles explicit overrides correctly", () => {
      const res = classifyWorkIntake({
        text: "Implement authentication feature with DB migration",
        overrideMode: "single_agent"
      });
      expect(res.category).toBe("explicit_override");
      expect(res.decisionMode).toBe("feature_plan");
      expect(res.actualMode).toBe("single_agent");
      expect(res.overrideApplied).toBe(true);
    });

    it("verifies secret scan returns zero findings for intake files", () => {
      const findings = scanWorktreePathsForSecrets(process.cwd(), [
        "src/intake/types.ts",
        "src/intake/classifier.ts",
        "src/intake/persistence.ts",
        "src/intake/evals.ts",
        "docs/WORK_INTAKE.md"
      ]);
      expect(findings).toEqual([]);
    });
  });

  describe("Persistence & Telemetry Integration", () => {
    it("saves and retrieves work intake classifications by task_id", () => {
      const task = database.createTask("Fix typo in README", "test", "testproj");
      const classification = classifyWorkIntake({ taskId: task.id, text: task.text });

      const saved = database.saveWorkIntakeClassification(classification);
      expect(saved.id).toBeGreaterThan(0);
      expect(saved.taskId).toBe(task.id);

      const retrieved = database.getWorkIntakeClassificationByTaskId(task.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.category).toBe("tiny_fix");
      expect(retrieved?.actualMode).toBe("single_agent");
      expect(retrieved?.priorWorkflowOverheadMs).toBe(4000);
    });

    it("automatically classifies tasks created via ApplicationCommands and emits telemetry events", () => {
      const task = commands.createTask(
        { channel: "dashboard" },
        { text: "Fix typo in variable name", projectKey: "testproj" }
      );

      const classification = database.getWorkIntakeClassificationByTaskId(task.id);
      expect(classification).not.toBeNull();
      expect(classification?.category).toBe("tiny_fix");
      expect(classification?.actualMode).toBe("single_agent");

      const events = database.listEvents(20);
      const classifiedEvent = events.find((e) => e.type === "work_intake_classified");
      expect(classifiedEvent).toBeDefined();
      expect(classifiedEvent?.taskId).toBe(task.id);
      expect(classifiedEvent?.metadata).toHaveProperty("estimatedOverheadMs");
      expect(classifiedEvent?.metadata).toHaveProperty("priorWorkflowOverheadMs");
    });

    it("emits work_intake_overridden event when an override is applied during task creation", () => {
      const task = commands.createTask(
        { channel: "dashboard" },
        { text: "Implement complex billing UI", projectKey: "testproj", overrideMode: "single_agent" }
      );

      const classification = database.getWorkIntakeClassificationByTaskId(task.id);
      expect(classification?.overrideApplied).toBe(true);
      expect(classification?.actualMode).toBe("single_agent");

      const events = database.listEvents(20);
      const overrideEvent = events.find((e) => e.type === "work_intake_overridden");
      expect(overrideEvent).toBeDefined();
      expect(overrideEvent?.taskId).toBe(task.id);
    });

    it("calculates aggregate metrics and overhead reduction ratio correctly", () => {
      const t1 = commands.createTask({ channel: "dashboard" }, { text: "Fix typo in config", projectKey: "testproj" });
      const t2 = commands.createTask({ channel: "dashboard" }, { text: "Update docs", projectKey: "testproj" });
      const t3 = commands.createTask({ channel: "dashboard" }, { text: "Audit security", projectKey: "testproj" });

      const metrics = database.getWorkIntakeMetrics();
      expect(metrics.totalClassifications).toBe(3);
      expect(metrics.categoryCounts.tiny_fix).toBe(1);
      expect(metrics.categoryCounts.documentation).toBe(1);
      expect(metrics.categoryCounts.audit).toBe(1);
      expect(metrics.averageOverheadMs).toBeLessThan(50);
      expect(metrics.averagePriorWorkflowOverheadMs).toBe(4000);
      expect(metrics.overheadReductionRatio).toBeGreaterThan(0.95);
    });
  });
});
