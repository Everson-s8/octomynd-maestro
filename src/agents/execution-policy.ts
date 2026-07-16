import type { AgentExecutionRequest } from "./types.js";

export type AgentFilesystemAccess = "read_only" | "workspace_write";

export function filesystemAccessForExecution(request: AgentExecutionRequest): AgentFilesystemAccess {
  if (request.workerContext?.mode === "read_only") return "read_only";
  return request.capability === "coding" || request.capability === "testing"
    ? "workspace_write"
    : "read_only";
}

export function isWritableExecution(request: AgentExecutionRequest): boolean {
  return filesystemAccessForExecution(request) === "workspace_write";
}
