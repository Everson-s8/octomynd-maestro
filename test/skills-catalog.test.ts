import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillCatalog } from "../src/skills/catalog.js";

const tempPaths: string[] = [];

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

describe("SkillCatalog", () => {
  it("discovers metadata and hashes the complete package without exposing instructions", () => {
    const root = tempRoot();
    const skillPath = writeSkill(root, "diagnose-goal-failure", {
      description: "Diagnose a failed Goal from artifacts. Use after a Goal fails or stalls.",
      body: "SECRET PROCEDURE BODY",
      policy: [
        "schemaVersion: 1",
        "owner: system",
        "risk: low",
        "allowImplicitInvocation: true",
        "capabilities: [research]",
        "operatingSystems: [win32, linux]",
        "network: none",
        "readScopes: ['.maestro/runs']",
        "writeScopes: []",
        "maxRuntimeMs: 30000",
        "maxOutputChars: 8000"
      ].join("\n")
    });
    fs.mkdirSync(path.join(skillPath, "references"));
    fs.writeFileSync(path.join(skillPath, "references", "failure-taxonomy.md"), "# Taxonomy\n");

    const snapshot = new SkillCatalog([{ scope: "repository", path: root }]).discover();

    expect(snapshot.issues).toEqual([]);
    expect(snapshot.skills).toHaveLength(1);
    expect(snapshot.skills[0]).toMatchObject({
      qualifiedName: "repository:diagnose-goal-failure",
      name: "diagnose-goal-failure",
      scope: "repository",
      fileCount: 3,
      resourcePaths: ["references/failure-taxonomy.md"]
    });
    expect(snapshot.skills[0]?.versionId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(snapshot.skills[0]?.policy).toMatchObject({
      owner: "system",
      allowImplicitInvocation: true,
      capabilities: ["research"],
      operatingSystems: ["win32", "linux"]
    });
    expect(JSON.stringify(snapshot)).not.toContain("SECRET PROCEDURE BODY");
  });

  it("changes the immutable version when any resource changes", () => {
    const root = tempRoot();
    const skillPath = writeSkill(root, "implement-task-safely", {
      description: "Implement one bounded Task safely. Use for approved coding Tasks.",
      body: "First version"
    });
    const first = new SkillCatalog([{ scope: "repository", path: root }]).discover().skills[0];

    fs.writeFileSync(path.join(skillPath, "SKILL.md"), skillMarkdown(
      "implement-task-safely",
      "Implement one bounded Task safely. Use for approved coding Tasks.",
      "Second version"
    ));
    const second = new SkillCatalog([{ scope: "repository", path: root }]).discover().skills[0];

    expect(first?.versionId).not.toBe(second?.versionId);
  });

  it("rejects malformed frontmatter and unsafe policy paths", () => {
    const root = tempRoot();
    const invalidName = path.join(root, "invalid-name");
    fs.mkdirSync(invalidName);
    fs.writeFileSync(path.join(invalidName, "SKILL.md"), skillMarkdown(
      "Invalid Name",
      "Invalid Skill.",
      "Body"
    ));
    writeSkill(root, "unsafe-policy", {
      description: "Unsafe policy example. Use only in a negative test.",
      body: "Body",
      policy: "writeScopes: ['../outside']"
    });

    const snapshot = new SkillCatalog([{ scope: "repository", path: root }]).discover();

    expect(snapshot.skills).toEqual([]);
    expect(snapshot.issues).toHaveLength(2);
    expect(snapshot.issues.map((issue) => issue.message).join(" ")).toContain("lowercase");
    expect(snapshot.issues.map((issue) => issue.message).join(" ")).toContain("safe relative paths");
  });

  it("rejects oversized packages and secret-shaped resources", () => {
    const root = tempRoot();
    const oversized = writeSkill(root, "oversized-skill", {
      description: "Oversized Skill. Use only in a negative test.",
      body: "Body"
    });
    fs.writeFileSync(path.join(oversized, "large.txt"), "x".repeat(200));
    const secret = writeSkill(root, "secret-skill", {
      description: "Secret Skill. Use only in a negative test.",
      body: "Body"
    });
    fs.writeFileSync(path.join(secret, ".env"), "OPENAI_API_KEY=not-real");

    const snapshot = new SkillCatalog(
      [{ scope: "repository", path: root }],
      { maxFileBytes: 100 }
    ).discover();

    expect(snapshot.skills).toEqual([]);
    expect(snapshot.issues).toHaveLength(2);
    expect(snapshot.issues.map((issue) => issue.message).join(" ")).toContain("too large");
    expect(snapshot.issues.map((issue) => issue.message).join(" ")).toContain("sensitive material");
  });

  it("rejects symbolic links that could escape the package", () => {
    const root = tempRoot();
    const outside = tempRoot();
    const skillPath = writeSkill(root, "linked-skill", {
      description: "Linked Skill. Use only in a negative test.",
      body: "Body"
    });
    const referencePath = path.join(skillPath, "references");
    fs.symlinkSync(outside, referencePath, process.platform === "win32" ? "junction" : "dir");

    const snapshot = new SkillCatalog([{ scope: "repository", path: root }]).discover();

    expect(snapshot.skills).toEqual([]);
    expect(snapshot.issues[0]?.message).toContain("Symbolic links are not allowed");
  });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-skills-"));
  tempPaths.push(root);
  return root;
}

function writeSkill(
  root: string,
  name: string,
  input: { description: string; body: string; policy?: string }
): string {
  const skillPath = path.join(root, name);
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(path.join(skillPath, "SKILL.md"), skillMarkdown(name, input.description, input.body));
  if (input.policy) fs.writeFileSync(path.join(skillPath, "maestro.yaml"), input.policy);
  return skillPath;
}

function skillMarkdown(name: string, description: string, body: string): string {
  return ["---", `name: ${name}`, `description: ${description}`, "---", "", body, ""].join("\n");
}
