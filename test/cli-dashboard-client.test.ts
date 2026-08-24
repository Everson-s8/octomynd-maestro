import http from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DashboardRequestError,
  dashboardUrl,
  requestDashboardJson
} from "../src/cli/dashboard-client.js";

let server: http.Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

describe("CLI dashboard client", () => {
  it("uses the same local dashboard endpoint and decodes JSON responses", async () => {
    server = http.createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ method: request.method, path: request.url }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    expect(dashboardUrl("api/health", { port })).toBe(`http://127.0.0.1:${port}/api/health`);
    await expect(requestDashboardJson<{ method: string; path: string }>("/api/health", {}, { port }))
      .resolves.toEqual({ method: "GET", path: "/api/health" });
  });

  it("preserves API error details and status for CLI commands", async () => {
    server = http.createServer((_request, response) => {
      response.statusCode = 409;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ error: "task_retry_failed", details: "Task is already running." }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const failure = await requestDashboardJson("/api/tasks/1/retry", { method: "POST" }, { port })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DashboardRequestError);
    expect(failure).toMatchObject({ message: "Task is already running.", status: 409 });
  });
});
