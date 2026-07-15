import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentCapability } from "../agents/types.js";
import { scanWorktreePathsForSecrets } from "../security/secrets.js";
import {
  DEFAULT_SKILL_CATALOG_LIMITS,
  SKILL_NETWORK_POLICIES,
  SKILL_OPERATING_SYSTEMS,
  SKILL_OWNERS,
  SKILL_RISKS,
  SkillCatalogIssue,
  SkillCatalogLimits,
  SkillCatalogRoot,
  SkillCatalogSnapshot,
  SkillMetadata,
  SkillOperatingSystem,
  SkillOwner,
  SkillPolicy,
  SkillRisk,
  SkillNetworkPolicy
} from "./types.js";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const POLICY_KEYS = new Set([
  "schemaVersion",
  "owner",
  "risk",
  "allowImplicitInvocation",
  "capabilities",
  "operatingSystems",
  "network",
  "readScopes",
  "writeScopes",
  "maxRuntimeMs",
  "maxOutputChars"
]);
const CAPABILITIES: AgentCapability[] = [
  "planning",
  "coding",
  "testing",
  "reviewing",
  "improvement_reviewing",
  "research",
  "conversation"
];

type PackageFile = {
  absolutePath: string;
  relativePath: string;
  size: number;
};

export class SkillCatalog {
  private readonly limits: SkillCatalogLimits;

  constructor(
    private readonly roots: readonly SkillCatalogRoot[],
    limits: Partial<SkillCatalogLimits> = {}
  ) {
    this.limits = { ...DEFAULT_SKILL_CATALOG_LIMITS, ...limits };
  }

  discover(): SkillCatalogSnapshot {
    const skills: SkillMetadata[] = [];
    const issues: SkillCatalogIssue[] = [];
    const qualifiedNames = new Set<string>();

    for (const root of this.roots) {
      const rootPath = path.resolve(root.path);
      if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
        issues.push({
          code: "root_missing",
          scope: root.scope,
          packageName: null,
          message: `Skill root is missing or is not a directory: ${root.scope}.`
        });
        continue;
      }

      for (const entry of fs.readdirSync(rootPath, { withFileTypes: true }).sort((left, right) => (
        left.name.localeCompare(right.name)
      ))) {
        if (!entry.isDirectory()) continue;
        const packagePath = path.join(rootPath, entry.name);
        try {
          const skill = inspectSkillPackage(root, packagePath, this.limits);
          if (qualifiedNames.has(skill.qualifiedName)) {
            issues.push({
              code: "duplicate_skill",
              scope: root.scope,
              packageName: skill.name,
              message: `Duplicate Skill in scope: ${skill.qualifiedName}.`
            });
            continue;
          }
          qualifiedNames.add(skill.qualifiedName);
          skills.push(skill);
        } catch (error) {
          issues.push({
            code: "invalid_package",
            scope: root.scope,
            packageName: entry.name,
            message: error instanceof Error ? error.message : "Invalid Skill package."
          });
        }
      }
    }

    return {
      skills: skills.sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName)),
      issues
    };
  }
}

export function inspectSkillPackage(
  root: SkillCatalogRoot,
  packagePath: string,
  limits: Partial<SkillCatalogLimits> = {}
): SkillMetadata {
  const effectiveLimits = { ...DEFAULT_SKILL_CATALOG_LIMITS, ...limits };
  const packageStat = fs.lstatSync(packagePath);
  if (packageStat.isSymbolicLink() || !packageStat.isDirectory()) {
    throw new Error("Skill package root must be a real directory.");
  }

  const files = collectPackageFiles(packagePath, effectiveLimits);
  const skillFile = files.find((file) => file.relativePath === "SKILL.md");
  if (!skillFile) throw new Error("SKILL.md is required.");
  if (skillFile.size > effectiveLimits.maxSkillMarkdownBytes) {
    throw new Error("SKILL.md exceeds the configured size limit.");
  }
  const policyFile = files.find((file) => file.relativePath === "maestro.yaml");
  if (policyFile && policyFile.size > effectiveLimits.maxPolicyBytes) {
    throw new Error("maestro.yaml exceeds the configured size limit.");
  }

  const secretFindings = scanWorktreePathsForSecrets(
    packagePath,
    files.map((file) => file.relativePath)
  );
  if (secretFindings.length > 0) {
    throw new Error(`Skill package contains sensitive material: ${secretFindings[0]?.relativePath}.`);
  }

  const frontmatter = parseSkillFrontmatter(fs.readFileSync(skillFile.absolutePath, "utf8"));
  const policy = policyFile
    ? parseSkillPolicy(fs.readFileSync(policyFile.absolutePath, "utf8"), root.scope)
    : defaultSkillPolicy(root.scope);
  const contentHash = hashPackageFiles(files);
  const totalBytes = files.reduce((total, file) => total + file.size, 0);

  return {
    qualifiedName: `${root.scope}:${frontmatter.name}`,
    name: frontmatter.name,
    description: frontmatter.description,
    scope: root.scope,
    projectKey: root.projectKey?.trim() || null,
    packagePath: path.resolve(packagePath),
    versionId: `sha256:${contentHash}`,
    contentHash,
    fileCount: files.length,
    totalBytes,
    policy,
    resourcePaths: files
      .map((file) => file.relativePath)
      .filter((relativePath) => relativePath !== "SKILL.md" && relativePath !== "maestro.yaml")
  };
}

function collectPackageFiles(packagePath: string, limits: SkillCatalogLimits): PackageFile[] {
  const files: PackageFile[] = [];
  let totalBytes = 0;
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => (
      left.name.localeCompare(right.name)
    ))) {
      const absolutePath = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolutePath);
      const relativePath = normalizeRelativePath(path.relative(packagePath, absolutePath));
      if (!isInsidePackage(relativePath)) throw new Error("Skill resource escapes its package root.");
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${relativePath}.`);
      if (stat.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Unsupported Skill resource: ${relativePath}.`);
      if (stat.size > limits.maxFileBytes) throw new Error(`Skill resource is too large: ${relativePath}.`);
      totalBytes += stat.size;
      if (totalBytes > limits.maxTotalBytes) throw new Error("Skill package exceeds the total size limit.");
      files.push({ absolutePath, relativePath, size: stat.size });
      if (files.length > limits.maxFiles) throw new Error("Skill package contains too many files.");
    }
  };
  visit(packagePath);
  return files;
}

function parseSkillFrontmatter(content: string): { name: string; description: string } {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) throw new Error("SKILL.md must start with YAML frontmatter.");
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) throw new Error("SKILL.md frontmatter is not closed.");
  const parsed = parseYaml(normalized.slice(4, closing));
  if (!isRecord(parsed)) throw new Error("SKILL.md frontmatter must be an object.");
  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
  if (!name || name.length > 64 || !SKILL_NAME.test(name)) {
    throw new Error("Skill name must use lowercase letters, numbers and hyphens, with at most 64 characters.");
  }
  if (!description || description.length > 1_024 || /<[^>]+>/.test(description)) {
    throw new Error("Skill description must be plain text with at most 1024 characters.");
  }
  return { name, description };
}

function parseSkillPolicy(content: string, scope: SkillCatalogRoot["scope"]): SkillPolicy {
  const parsed = parseYaml(content);
  if (!isRecord(parsed)) throw new Error("maestro.yaml must be an object.");
  const unknown = Object.keys(parsed).filter((key) => !POLICY_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`Unknown Maestro Skill policy key: ${unknown[0]}.`);
  const defaults = defaultSkillPolicy(scope);
  const schemaVersion = parsed.schemaVersion ?? defaults.schemaVersion;
  if (schemaVersion !== 1) throw new Error("Unsupported Maestro Skill policy schemaVersion.");
  return {
    schemaVersion: 1,
    owner: enumValue(parsed.owner, SKILL_OWNERS, defaults.owner, "owner") as SkillOwner,
    risk: enumValue(parsed.risk, SKILL_RISKS, defaults.risk, "risk") as SkillRisk,
    allowImplicitInvocation: booleanValue(
      parsed.allowImplicitInvocation,
      defaults.allowImplicitInvocation,
      "allowImplicitInvocation"
    ),
    capabilities: enumArray(parsed.capabilities, CAPABILITIES, defaults.capabilities, "capabilities"),
    operatingSystems: enumArray(
      parsed.operatingSystems,
      SKILL_OPERATING_SYSTEMS,
      defaults.operatingSystems,
      "operatingSystems"
    ) as SkillOperatingSystem[],
    network: enumValue(
      parsed.network,
      SKILL_NETWORK_POLICIES,
      defaults.network,
      "network"
    ) as SkillNetworkPolicy,
    readScopes: relativePathArray(parsed.readScopes, defaults.readScopes, "readScopes"),
    writeScopes: relativePathArray(parsed.writeScopes, defaults.writeScopes, "writeScopes"),
    maxRuntimeMs: boundedInteger(parsed.maxRuntimeMs, defaults.maxRuntimeMs, 1_000, 900_000, "maxRuntimeMs"),
    maxOutputChars: boundedInteger(
      parsed.maxOutputChars,
      defaults.maxOutputChars,
      1_000,
      100_000,
      "maxOutputChars"
    )
  };
}

function defaultSkillPolicy(scope: SkillCatalogRoot["scope"]): SkillPolicy {
  return {
    schemaVersion: 1,
    owner: scope === "system" ? "system" : "user",
    risk: "low",
    allowImplicitInvocation: false,
    capabilities: [],
    operatingSystems: [...SKILL_OPERATING_SYSTEMS],
    network: "none",
    readScopes: ["."],
    writeScopes: [],
    maxRuntimeMs: 120_000,
    maxOutputChars: 20_000
  };
}

function hashPackageFiles(files: PackageFile[]): string {
  const hash = crypto.createHash("sha256");
  for (const file of [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(file.absolutePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function relativePathArray(value: unknown, fallback: string[], name: string): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && isSafeRelativeScope(item))) {
    throw new Error(`${name} must contain safe relative paths.`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function isSafeRelativeScope(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || path.isAbsolute(trimmed)) return false;
  const normalized = normalizeRelativePath(path.normalize(trimmed));
  return normalized === "." || isInsidePackage(normalized);
}

function enumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T[],
  name: string
): T[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && allowed.includes(item as T))) {
    throw new Error(`${name} contains an unsupported value.`);
  }
  return [...new Set(value as T[])];
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  name: string
): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${name} contains an unsupported value.`);
  }
  return value as T;
}

function booleanValue(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} is outside the allowed range.`);
  }
  return value as number;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isInsidePackage(relativePath: string): boolean {
  return relativePath !== ".."
    && !relativePath.startsWith("../")
    && !path.isAbsolute(relativePath)
    && !/^[A-Za-z]:\//.test(relativePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
