import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type { AgentCapability } from "../agents/types.js";
import type {
  GoalPhase,
  MaestroDatabase,
  SkillEvaluationCheck,
  SkillEvaluationRecord,
  SkillVersionRecord
} from "../db.js";
import { scoreSkillRelevance } from "./runtime.js";
import { SkillVersionStore } from "./store.js";

type TriggerEvalCase = {
  id: string;
  type: "trigger";
  prompt: string;
  phase: GoalPhase;
  capability: AgentCapability;
  expectMatch: boolean;
};
type ContentEvalCase = {
  id: string;
  type: "content";
  requiredPhrases: string[];
  forbiddenPhrases: string[];
};
type ScriptSyntaxEvalCase = {
  id: string;
  type: "script_syntax";
  path: string;
};
type SkillEvalCase = TriggerEvalCase | ContentEvalCase | ScriptSyntaxEvalCase;

export class SkillEvaluationHarness {
  constructor(
    private readonly database: MaestroDatabase,
    private readonly store: SkillVersionStore
  ) {}

  evaluate(skillVersionRecordId: number): SkillEvaluationRecord {
    const startedAt = Date.now();
    const version = this.database.getSkillVersion(skillVersionRecordId);
    const checks: SkillEvaluationCheck[] = [];
    let securityPassed = false;
    let estimatedTokens = 0;

    try {
      const snapshot = this.store.verifySnapshot(version);
      const instructions = this.store.readSkillMarkdown(version);
      estimatedTokens += estimateTokens(instructions);
      const policySafe = !snapshot.policy.allowImplicitInvocation
        || (snapshot.policy.risk === "low"
          && snapshot.policy.network === "none"
          && snapshot.policy.writeScopes.length === 0);
      checks.push({
        id: "policy-security",
        type: "security",
        status: policySafe ? "passed" : "failed",
        message: policySafe
          ? "Implicit invocation does not grant network or write access."
          : "Implicit invocation may not grant network, write access or elevated risk."
      });
      securityPassed = policySafe;

      const evalPath = path.join(snapshot.packagePath, "evals", "cases.yaml");
      const cases = parseEvalCases(evalPath);
      for (const item of cases) {
        if (item.type === "trigger") {
          estimatedTokens += estimateTokens(item.prompt);
          const score = scoreSkillRelevance(snapshot.name, snapshot.description, {
            taskText: item.prompt,
            phase: item.phase,
            capability: item.capability
          });
          const matched = score > 0;
          const passed = matched === item.expectMatch;
          checks.push({
            id: item.id,
            type: item.type,
            status: passed ? "passed" : "failed",
            message: `Expected match=${item.expectMatch}; observed match=${matched}; score=${score}.`
          });
          continue;
        }
        if (item.type === "content") {
          const missing = item.requiredPhrases.filter((phrase) => !instructions.includes(phrase));
          const forbidden = item.forbiddenPhrases.filter((phrase) => instructions.includes(phrase));
          const passed = missing.length === 0 && forbidden.length === 0;
          checks.push({
            id: item.id,
            type: item.type,
            status: passed ? "passed" : "failed",
            message: passed
              ? "Required workflow guardrails are present."
              : `Missing=${missing.length}; forbidden=${forbidden.length}.`
          });
          continue;
        }
        checks.push(evaluateScriptSyntax(snapshot.packagePath, item));
      }
    } catch (error) {
      checks.push({
        id: "harness-error",
        type: "security",
        status: "failed",
        message: error instanceof Error ? error.message : "Skill evaluation failed unexpectedly."
      });
    }

    const failures = checks.filter((check) => check.status === "failed").length;
    const qualityScore = checks.length === 0 ? 0 : (checks.length - failures) / checks.length;
    const baseline = baselineEvaluation(this.database, version);
    const regressionDetected = Boolean(
      baseline
      && (qualityScore < baseline.qualityScore || failures > baseline.failures)
    );
    const status = failures === 0 && securityPassed && !regressionDetected ? "passed" : "failed";
    const evaluation = this.database.recordSkillEvaluation({
      skillVersionRecordId,
      status,
      qualityScore,
      durationMs: Date.now() - startedAt,
      estimatedTokens,
      attempts: checks.length,
      failures,
      securityPassed,
      regressionDetected,
      baselineVersionId: baseline?.versionId ?? null,
      checks
    });
    if (evaluation.status === "passed" && version.status === "candidate") {
      this.database.updateSkillVersionStatus(version.id, "evaluated");
    }
    return evaluation;
  }
}

function baselineEvaluation(
  database: MaestroDatabase,
  candidate: SkillVersionRecord
): SkillEvaluationRecord | null {
  const skill = database.getSkillByQualifiedName(candidate.qualifiedName);
  if (!skill.activeVersionId || skill.activeVersionId === candidate.versionId) return null;
  const active = database.getSkillVersionByCoordinates(skill.qualifiedName, skill.activeVersionId);
  return database.getLatestSkillEvaluation(active.id);
}

function parseEvalCases(filePath: string): SkillEvalCase[] {
  if (!fs.existsSync(filePath)) throw new Error("Skill evals/cases.yaml is required before activation.");
  const parsed = parseYaml(fs.readFileSync(filePath, "utf8"));
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.cases)) {
    throw new Error("Skill eval file must declare schemaVersion 1 and a cases array.");
  }
  if (parsed.cases.length < 2 || parsed.cases.length > 64) {
    throw new Error("Skill evaluation requires between 2 and 64 cases.");
  }
  const ids = new Set<string>();
  return parsed.cases.map((value) => parseEvalCase(value, ids));
}

function parseEvalCase(value: unknown, ids: Set<string>): SkillEvalCase {
  if (!isRecord(value)) throw new Error("Skill eval case must be an object.");
  const id = boundedString(value.id, 80, "Skill eval id");
  if (ids.has(id)) throw new Error(`Duplicate Skill eval id: ${id}.`);
  ids.add(id);
  if (value.type === "trigger") {
    const phase = enumValue(value.phase, ["planning", "implementing", "testing", "reviewing"] as const, "phase");
    const capability = enumValue(
      value.capability,
      ["planning", "coding", "testing", "reviewing", "improvement_reviewing", "research", "conversation"] as const,
      "capability"
    );
    if (typeof value.expectMatch !== "boolean") throw new Error(`${id} requires expectMatch.`);
    return {
      id,
      type: "trigger",
      prompt: boundedString(value.prompt, 1_000, `${id} prompt`),
      phase,
      capability,
      expectMatch: value.expectMatch
    };
  }
  if (value.type === "content") {
    return {
      id,
      type: "content",
      requiredPhrases: stringArray(value.requiredPhrases, 20, `${id} requiredPhrases`),
      forbiddenPhrases: stringArray(value.forbiddenPhrases ?? [], 20, `${id} forbiddenPhrases`)
    };
  }
  if (value.type === "script_syntax") {
    return { id, type: "script_syntax", path: safeRelativePath(value.path, id) };
  }
  throw new Error(`Unsupported Skill eval type for ${id}.`);
}

function evaluateScriptSyntax(packagePath: string, item: ScriptSyntaxEvalCase): SkillEvaluationCheck {
  const scriptPath = path.resolve(packagePath, item.path);
  const relative = path.relative(packagePath, scriptPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { id: item.id, type: item.type, status: "failed", message: "Script path escapes the Skill package." };
  }
  if (!fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) {
    return { id: item.id, type: item.type, status: "failed", message: "Script file does not exist." };
  }
  if (![".js", ".cjs", ".mjs"].includes(path.extname(scriptPath).toLowerCase())) {
    return { id: item.id, type: item.type, status: "failed", message: "Only JavaScript syntax checks are supported." };
  }
  const result = spawnSync(process.execPath, ["--check", scriptPath], {
    cwd: packagePath,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true
  });
  return {
    id: item.id,
    type: item.type,
    status: result.status === 0 && !result.error ? "passed" : "failed",
    message: result.status === 0 && !result.error ? "Script syntax is valid." : "Script syntax check failed."
  };
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function boundedString(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function stringArray(value: unknown, max: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > max || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`${label} is invalid.`);
  }
  return value.map((item) => (item as string).trim());
}

function safeRelativePath(value: unknown, id: string): string {
  const relative = boundedString(value, 240, `${id} path`).replaceAll("\\", "/");
  if (path.isAbsolute(relative) || relative.split("/").includes("..")) throw new Error(`${id} path is unsafe.`);
  return relative;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`Skill eval ${label} is invalid.`);
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
