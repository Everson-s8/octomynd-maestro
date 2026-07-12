import fs from "node:fs";
import http, { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { ClaudeReviewer, reviewTaskWithClaude } from "../agents/claude.js";
import { MaestroConfig } from "../config.js";
import {
  ImprovementCategory,
  ImprovementRisk,
  ImprovementStatus,
  MaestroDatabase
} from "../db.js";
import { createProjectTask, prepareTask } from "../orchestrator.js";
import { buildDashboardSnapshot } from "./snapshot.js";

export type DashboardServerOptions = {
  config: MaestroConfig;
  database: MaestroDatabase;
  staticRoot?: string;
  claudeReviewer?: ClaudeReviewer;
};

export function createDashboardServer(options: DashboardServerOptions) {
  const staticRoot = options.staticRoot ?? path.resolve(process.cwd(), "ui/dist");

  return http.createServer(async (request, response) => {
    try {
      await routeRequest(request, response, options, staticRoot);
    } catch (error) {
      console.error("Dashboard request failed:", error instanceof Error ? error.message : "unknown error");
      sendJson(response, 500, { error: "dashboard_request_failed" });
    }
  });
}

export async function startDashboardServer(options: DashboardServerOptions) {
  const server = createDashboardServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.config.dashboard.port, options.config.dashboard.host, () => resolve());
  });
  return server;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: DashboardServerOptions,
  staticRoot: string
) {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      service: options.config.projectName,
      generatedAt: new Date().toISOString()
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    sendJson(response, 200, buildDashboardSnapshot(options.config, options.database));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/improvements") {
    sendJson(response, 200, { improvements: options.database.listImprovementProposals() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/improvements") {
    const body = await readJsonBody(request);
    const category = readEnum(body.category, ["skill", "memory", "routing", "policy", "integration"]);
    const risk = readEnum(body.risk, ["low", "medium", "high"]);
    const title = readString(body.title);
    const rationale = readString(body.rationale);
    const proposedChange = readString(body.proposedChange);
    const evidence = Array.isArray(body.evidence)
      ? body.evidence.filter((item): item is string => typeof item === "string")
      : [];

    if (!category || !risk || !title || !rationale || !proposedChange || evidence.length === 0) {
      sendJson(response, 400, { error: "invalid_improvement_proposal" });
      return;
    }

    try {
      const improvement = options.database.createImprovementProposal({
        category: category as ImprovementCategory,
        title,
        rationale,
        proposedChange,
        evidence,
        risk: risk as ImprovementRisk,
        source: "dashboard"
      });
      options.database.addEvent({
        source: "maestro",
        type: "improvement.proposed",
        text: improvement.title,
        metadata: { improvementId: improvement.id, risk: improvement.risk, category: improvement.category }
      });
      sendJson(response, 201, { improvement });
    } catch (error) {
      sendJson(response, 400, {
        error: "invalid_improvement_proposal",
        details: error instanceof Error ? error.message : "Unknown validation error"
      });
    }
    return;
  }

  const improvementDecisionMatch = url.pathname.match(/^\/api\/improvements\/(\d+)\/decision$/);
  if (request.method === "POST" && improvementDecisionMatch) {
    const improvementId = Number(improvementDecisionMatch[1]);
    const body = await readJsonBody(request);
    const status = readEnum(body.status, ["approved", "rejected"]);
    const decisionNote = readString(body.decisionNote) || null;
    if (!status) {
      sendJson(response, 400, { error: "approved_or_rejected_status_required" });
      return;
    }

    try {
      const improvement = options.database.decideImprovementProposal(
        improvementId,
        status as Exclude<ImprovementStatus, "candidate">,
        decisionNote
      );
      options.database.addEvent({
        source: "human",
        type: `improvement.${improvement.status}`,
        text: improvement.title,
        metadata: { improvementId: improvement.id, decisionNote: improvement.decisionNote }
      });
      sendJson(response, 200, { improvement });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown decision error";
      sendJson(response, message.includes("not found") ? 404 : 409, {
        error: "improvement_decision_failed",
        details: message
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tasks") {
    const body = await readJsonBody(request);
    const projectKey = typeof body.projectKey === "string" ? body.projectKey.trim().toLowerCase() : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";

    if (!projectKey || !text) {
      sendJson(response, 400, { error: "projectKey_and_text_are_required" });
      return;
    }

    const project = options.database.findProjectByKey(projectKey);
    if (!project) {
      sendJson(response, 404, { error: "project_not_found" });
      return;
    }

    const task = createProjectTask(options.database, text, project.key);
    options.database.addEvent({
      source: "dashboard",
      type: "task.created",
      text,
      taskId: task.id,
      metadata: { projectKey: project.key }
    });
    sendJson(response, 201, { task });
    return;
  }

  const prepareMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/prepare$/);
  if (request.method === "POST" && prepareMatch) {
    const taskId = Number(prepareMatch[1]);
    const result = prepareTask(options.database, taskId, options.config.worktreesPath);
    if (!result.ok) {
      options.database.addEvent({
        source: "dashboard",
        type: "task.prepare_failed",
        text: result.errors.join("\n"),
        taskId
      });
      sendJson(response, 409, { error: "task_prepare_failed", details: result.errors });
      return;
    }

    options.database.addEvent({
      source: "dashboard",
      type: "task.prepared",
      text: result.branchName,
      taskId,
      metadata: {
        branchName: result.branchName,
        worktreePath: result.worktreePath
      }
    });
    sendJson(response, 200, { task: result.task });
    return;
  }

  const reviewsMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/reviews$/);
  if (request.method === "GET" && reviewsMatch) {
    const taskId = Number(reviewsMatch[1]);
    try {
      options.database.getTask(taskId);
    } catch {
      sendJson(response, 404, { error: "task_not_found" });
      return;
    }
    sendJson(response, 200, { reviews: options.database.listTaskReviews(taskId) });
    return;
  }

  const claudeReviewMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/reviews\/claude$/);
  if (request.method === "POST" && claudeReviewMatch) {
    const taskId = Number(claudeReviewMatch[1]);
    let task;
    try {
      task = options.database.getTask(taskId);
    } catch {
      sendJson(response, 404, { error: "task_not_found" });
      return;
    }

    if (!task.projectKey || !task.worktreePath) {
      sendJson(response, 409, { error: "task_worktree_required" });
      return;
    }

    const project = options.database.getProjectByKey(task.projectKey);
    const reviewer = options.claudeReviewer ?? reviewTaskWithClaude;
    const result = await reviewer(task, project);
    const review = options.database.addTaskReview({
      taskId,
      provider: "claude",
      status: result.status,
      content: result.content,
      error: result.error
    });

    options.database.addEvent({
      source: "claude",
      type: result.status === "completed" ? "task.reviewed" : "task.review_failed",
      text: result.status === "completed" ? `Claude review #${review.id}` : result.error ?? "Claude review failed",
      taskId,
      metadata: { reviewId: review.id, status: result.status, durationMs: result.durationMs }
    });

    const statusCode = result.status === "completed" ? 201 : result.status === "auth_required" ? 503 : 500;
    sendJson(response, statusCode, { review });
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  serveStatic(response, staticRoot, url.pathname);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) {
      throw new Error("Request body exceeds 64 KB.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readEnum(value: unknown, options: readonly string[]): string | null {
  return typeof value === "string" && options.includes(value) ? value : null;
}

function serveStatic(response: ServerResponse, staticRoot: string, pathname: string) {
  if (!fs.existsSync(staticRoot)) {
    sendJson(response, 404, { error: "ui_not_built", hint: "Run npm run build:ui." });
    return;
  }

  const requestedPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolvedPath = path.resolve(staticRoot, requestedPath);
  const safeRoot = `${path.resolve(staticRoot)}${path.sep}`;
  const candidate = resolvedPath.startsWith(safeRoot) ? resolvedPath : path.join(staticRoot, "index.html");
  const filePath = fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : path.join(staticRoot, "index.html");

  if (!fs.existsSync(filePath)) {
    sendJson(response, 404, { error: "ui_entry_missing" });
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable"
  });
  fs.createReadStream(filePath).pipe(response);
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  response.end(JSON.stringify(payload));
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml"
  }[extension] ?? "application/octet-stream";
}
