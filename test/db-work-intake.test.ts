import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { classifyWorkIntake } from "../src/intake/policy.js";

let tempDir: string;
let database: MaestroDatabase;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-work-intake-test-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Work Intake persistence", () => {
  it("saves and retrieves work intake decisions", () => {
    const decision = classifyWorkIntake({
      id: "intake-test-1",
      projectKey: "octomynd",
      objective: "Add durable intake persistence",
      coordination: {
        dependsOnCount: 0,
        parallelWorkstreamCount: 1,
        requiresMultipleReviewGates: false
      },
      acceptanceCriteria: ["Create schema", "Add persistence methods"]
    });

    const saved = database.saveWorkIntakeDecision(decision);
    expect(saved.id).toBe("intake-test-1");
    expect(saved.projectKey).toBe("octomynd");
    expect(saved.classification).toBe("direct_task");
    expect(saved.reasonCode).toBe("single_bounded_objective");

    const retrieved = database.getWorkIntakeDecision("intake-test-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe("intake-test-1");
    expect(retrieved?.evidence.schemaVersion).toBe(1);
    expect(retrieved?.evidence.facts.length).toBeGreaterThan(0);
  });

  it("lists work intake decisions filtered by project or classification", () => {
    const decision1 = classifyWorkIntake({
      id: "intake-list-1",
      projectKey: "octomynd",
      objective: "Simple task 1"
    });
    const decision2 = classifyWorkIntake({
      id: "intake-list-2",
      projectKey: "octomynd",
      objective: "Complex multi-gate feature 2",
      coordination: { parallelWorkstreamCount: 3, requiresMultipleReviewGates: true }
    });
    const decision3 = classifyWorkIntake({
      id: "intake-list-3",
      projectKey: "other-proj",
      objective: "Other project task"
    });

    database.saveWorkIntakeDecision(decision1);
    database.saveWorkIntakeDecision(decision2);
    database.saveWorkIntakeDecision(decision3);

    const octomyndDecisions = database.listWorkIntakeDecisions({ projectKey: "octomynd" });
    expect(octomyndDecisions).toHaveLength(2);

    const featurePlans = database.listWorkIntakeDecisions({ classification: "feature_plan" });
    expect(featurePlans).toHaveLength(1);
    expect(featurePlans[0].id).toBe("intake-list-2");
  });
});
