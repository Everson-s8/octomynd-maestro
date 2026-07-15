import type { AgentCapability } from "../agents/types.js";

export const SKILL_SCOPES = ["system", "user", "repository", "project"] as const;
export const SKILL_OWNERS = ["system", "user", "agent"] as const;
export const SKILL_RISKS = ["low", "medium", "high"] as const;
export const SKILL_NETWORK_POLICIES = ["none", "restricted", "full"] as const;
export const SKILL_OPERATING_SYSTEMS = ["win32", "linux", "darwin"] as const;

export type SkillScope = typeof SKILL_SCOPES[number];
export type SkillOwner = typeof SKILL_OWNERS[number];
export type SkillRisk = typeof SKILL_RISKS[number];
export type SkillNetworkPolicy = typeof SKILL_NETWORK_POLICIES[number];
export type SkillOperatingSystem = typeof SKILL_OPERATING_SYSTEMS[number];

export type SkillPolicy = {
  schemaVersion: 1;
  owner: SkillOwner;
  risk: SkillRisk;
  allowImplicitInvocation: boolean;
  capabilities: AgentCapability[];
  operatingSystems: SkillOperatingSystem[];
  network: SkillNetworkPolicy;
  readScopes: string[];
  writeScopes: string[];
  maxRuntimeMs: number;
  maxOutputChars: number;
};

export type SkillCatalogRoot = {
  scope: SkillScope;
  path: string;
  projectKey?: string | null;
};

export type SkillMetadata = {
  qualifiedName: string;
  name: string;
  description: string;
  scope: SkillScope;
  projectKey: string | null;
  packagePath: string;
  versionId: string;
  contentHash: string;
  fileCount: number;
  totalBytes: number;
  policy: SkillPolicy;
  resourcePaths: string[];
};

export type SkillCatalogIssueCode =
  | "root_missing"
  | "invalid_package"
  | "duplicate_skill";

export type SkillCatalogIssue = {
  code: SkillCatalogIssueCode;
  scope: SkillScope;
  packageName: string | null;
  message: string;
};

export type SkillCatalogSnapshot = {
  skills: SkillMetadata[];
  issues: SkillCatalogIssue[];
};

export type SkillCatalogLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxSkillMarkdownBytes: number;
  maxPolicyBytes: number;
};

export const DEFAULT_SKILL_CATALOG_LIMITS: SkillCatalogLimits = {
  maxFiles: 128,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 4_000_000,
  maxSkillMarkdownBytes: 128_000,
  maxPolicyBytes: 32_000
};
