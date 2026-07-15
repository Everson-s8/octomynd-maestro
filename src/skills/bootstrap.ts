import type { MaestroDatabase } from "../db.js";
import { SkillCatalog } from "./catalog.js";
import { SkillEvaluationHarness } from "./evaluation.js";
import { SkillRuntime } from "./runtime.js";
import { SkillVersionStore } from "./store.js";

const BUILTIN_SKILLS = new Set([
  "repository:diagnose-goal-failure",
  "repository:implement-task-safely",
  "repository:final-feature-review"
]);

export type SkillBootstrapResult = {
  runtime: SkillRuntime;
  registered: Array<{ qualifiedName: string; versionId: string; status: string }>;
  active: Array<{ qualifiedName: string; versionId: string }>;
};

export function bootstrapSkills(input: {
  database: MaestroDatabase;
  catalogPath: string;
  versionsPath: string;
  projectKey: string;
}): SkillBootstrapResult {
  const snapshot = new SkillCatalog([{
    scope: "repository",
    path: input.catalogPath,
    projectKey: input.projectKey
  }]).discover();
  if (snapshot.issues.length > 0) {
    throw new Error(`Skill catalog failed closed: ${snapshot.issues.map((issue) => issue.message).join("; ")}`);
  }
  const store = new SkillVersionStore(input.database, input.versionsPath);
  const harness = new SkillEvaluationHarness(input.database, store);
  const registered = [];
  const active = [];

  for (const metadata of snapshot.skills) {
    let version = store.register(metadata);
    if (BUILTIN_SKILLS.has(version.qualifiedName)) {
      if (version.policy.owner !== "system") {
        throw new Error(`Built-in Skill must remain system-owned: ${version.qualifiedName}.`);
      }
      if (version.status === "candidate") {
        const evaluation = harness.evaluate(version.id);
        if (evaluation.status !== "passed") {
          throw new Error(`Built-in Skill evaluation failed: ${version.qualifiedName}.`);
        }
        version = input.database.getSkillVersion(version.id);
      }
      if (version.status === "evaluated") {
        version = input.database.updateSkillVersionStatus(version.id, "approved");
      }
      if (version.status === "approved") {
        version = input.database.activateSkillVersion(version.id);
      }
      if (version.status === "active") {
        active.push({ qualifiedName: version.qualifiedName, versionId: version.versionId });
      }
    }
    registered.push({
      qualifiedName: version.qualifiedName,
      versionId: version.versionId,
      status: version.status
    });
  }

  return {
    runtime: new SkillRuntime(input.database, store),
    registered,
    active
  };
}
