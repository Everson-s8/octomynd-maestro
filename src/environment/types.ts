import type { AgentCapability } from "../agents/types.js";

export type EnvironmentReadinessStatus =
  | "ready"
  | "environment_blocked"
  | "auth_required"
  | "quota"
  | "offline";

export type EnvironmentCheckStatus = "passed" | "warning" | "failed" | "skipped";

export type EnvironmentCheckName =
  | "execution_paths"
  | "temporary_write"
  | "worktree"
  | "git"
  | "node"
  | "npm"
  | "typescript"
  | "test_runner"
  | "providers";

export type EnvironmentCheck = {
  name: EnvironmentCheckName;
  status: EnvironmentCheckStatus;
  summary: string;
  classification?: Exclude<EnvironmentReadinessStatus, "ready">;
  evidence: string[];
};

export type EnvironmentDoctorReport = {
  status: EnvironmentReadinessStatus;
  summary: string;
  recommendedAction: string;
  checkedAt: string;
  projectKey: string;
  taskId: number | null;
  fingerprintId: string;
  requiredCapabilities: AgentCapability[];
  checks: EnvironmentCheck[];
};
