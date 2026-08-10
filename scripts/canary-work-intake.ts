import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../src/db.js";
import { ApplicationCommands } from "../src/commands/application-commands.js";

async function runWorkIntakeCanary() {
  console.log("=== Running Governed Work Intake Canary (Local E2E) ===");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-canary-e2e-"));
  const projectDir = path.join(tempDir, "canary-project");
  fs.mkdirSync(projectDir);

  const dbPath = path.join(tempDir, "canary.db");
  const db = createDatabase(dbPath);
  const commands = new ApplicationCommands(db);

  commands.registerProject(
    { channel: "canary" },
    { key: "canary", path: projectDir, name: "Canary Project" }
  );

  // 1. Bounded Maintenance Request
  console.log("\n[1/3] Submitting bounded maintenance request...");
  const maintenanceResult = commands.submitWorkIntake(
    { channel: "canary", userId: "canary-runner" },
    {
      projectKey: "canary",
      objective: "Fix typo in README footer"
    }
  );
  console.log(`  -> Status: ${maintenanceResult.status}, CreatedType: ${maintenanceResult.createdType}`);
  console.log(`  -> ReasonCode: ${maintenanceResult.decision.reasonCode}`);
  if (maintenanceResult.status !== "created" || maintenanceResult.createdType !== "task") {
    throw new Error(`Canary 1 Failed: Expected direct task, got ${maintenanceResult.createdType}`);
  }
  const tasksAfter1 = db.listTasksByProject("canary");
  const plansAfter1 = db.listFeaturePlansByProject("canary");
  if (tasksAfter1.length !== 1 || plansAfter1.length !== 0) {
    throw new Error(`Canary 1 DB state error: expected 1 task & 0 plans, found ${tasksAfter1.length} tasks & ${plansAfter1.length} plans`);
  }
  console.log("  [PASS] Canary 1: Bounded maintenance created exactly 1 direct task and 0 feature plans.");

  // 2. Ambiguous Request
  console.log("\n[2/3] Submitting ambiguous request...");
  const ambiguousResult = commands.submitWorkIntake(
    { channel: "canary", userId: "canary-runner" },
    {
      projectKey: "canary",
      objective: "..."
    }
  );
  console.log(`  -> Status: ${ambiguousResult.status}, CreatedType: ${ambiguousResult.createdType}`);
  console.log(`  -> ReasonCode: ${ambiguousResult.decision.reasonCode}`);
  if (ambiguousResult.status !== "needs_clarification" || ambiguousResult.createdType !== "none") {
    throw new Error(`Canary 2 Failed: Expected needs_clarification, got ${ambiguousResult.status}`);
  }
  const tasksAfter2 = db.listTasksByProject("canary");
  const plansAfter2 = db.listFeaturePlansByProject("canary");
  if (tasksAfter2.length !== 1 || plansAfter2.length !== 0) {
    throw new Error(`Canary 2 DB state error: expected tasks to remain 1 & plans 0, found ${tasksAfter2.length} tasks & ${plansAfter2.length} plans`);
  }
  const persistedDecision2 = db.getWorkIntakeDecision(ambiguousResult.decision.id);
  if (!persistedDecision2 || persistedDecision2.classification !== "needs_clarification") {
    throw new Error("Canary 2 DB decision state error: clarification decision was not persisted");
  }
  console.log("  [PASS] Canary 2: Ambiguous request asked for clarification without creating tasks or plans.");

  // 3. Genuinely Dependent Work
  console.log("\n[3/3] Submitting genuinely dependent work...");
  const dependentResult = commands.submitWorkIntake(
    { channel: "canary", userId: "canary-runner" },
    {
      projectKey: "canary",
      objective: "Migrate auth service with backend dependency",
      coordination: { dependsOnCount: 1 }
    }
  );
  console.log(`  -> Status: ${dependentResult.status}, CreatedType: ${dependentResult.createdType}`);
  console.log(`  -> ReasonCode: ${dependentResult.decision.reasonCode}`);
  if (dependentResult.status !== "created" || dependentResult.createdType !== "feature_plan") {
    throw new Error(`Canary 3 Failed: Expected feature_plan, got ${dependentResult.createdType}`);
  }
  const tasksAfter3 = db.listTasksByProject("canary");
  const plansAfter3 = db.listFeaturePlansByProject("canary");
  if (plansAfter3.length !== 1 || tasksAfter3.length !== 2) {
    throw new Error(`Canary 3 DB state error: expected 1 feature plan & 2 total tasks, found ${plansAfter3.length} plans & ${tasksAfter3.length} tasks`);
  }
  console.log("  [PASS] Canary 3: Genuinely dependent work created exactly 1 feature plan with attached task.");

  // Cleanup
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log("\n=== Governed Work Intake Canary: ALL 3 VERIFICATIONS PASSED ===");
}

runWorkIntakeCanary().catch((err) => {
  console.error("Canary E2E Failed:", err);
  process.exit(1);
});
