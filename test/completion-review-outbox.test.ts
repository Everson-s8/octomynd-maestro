import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase } from "../src/db.js";
import { CompletionReviewOutbox } from "../src/improvements/outbox.js";
import { containsSensitiveText } from "../src/security/redaction.js";

let tempDir: string;
let database: MaestroDatabase;
let databasePath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-outbox-test-"));
  databasePath = path.join(tempDir, "maestro.db");
  database = createDatabase(databasePath);
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("completion review outbox", () => {
  it("persists bounded sanitized evidence with provenance", () => {
    const secret = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const feature = createCompletedFeature({
      objective: `${secret} C:\\Users\\alice\\private\\repo ${"x".repeat(2_000)}`,
      reviewSummary: `Reviewed ${secret}`
    });

    const review = database.enqueueFeatureCompletionReview(feature.id);
    const serialized = JSON.stringify(review.evidence);

    expect(review.subjectType).toBe("feature");
    expect(review.completionVersion).toBe("abc123-reviewed-head");
    expect(review.evidence.trigger).toBe("feature_completed");
    expect(containsSensitiveText(serialized)).toBe(false);
    expect(serialized).toContain("[REDACTED_SECRET]");
    expect(serialized).toContain("[REDACTED_LOCAL_PATH]");
    expect(Math.max(...review.evidence.facts.map((fact) => fact.value.length))).toBeLessThanOrEqual(1_000);
    expect(review.evidence.facts.every((fact) => (
      fact.provenance.sourceId === String(feature.id)
      && fact.provenance.sourceVersion === feature.reviewedHeadSha
      && fact.provenance.field === fact.key
    ))).toBe(true);
  });

  it("enqueues each completion identity once across polling and restart", () => {
    const feature = createCompletedFeature();
    const outbox = new CompletionReviewOutbox(database);

    expect(outbox.reconcileCompletedFeatures()).toBe(1);
    expect(outbox.reconcileCompletedFeatures()).toBe(0);
    expect(database.listCompletionReviews()).toHaveLength(1);

    database.close();
    database = createDatabase(databasePath);

    expect(new CompletionReviewOutbox(database).reconcileCompletedFeatures()).toBe(0);
    expect(database.listCompletionReviews()).toHaveLength(1);
    expect(database.listCompletionReviews()[0].subjectId).toBe(String(feature.id));
  });

  it("recovers expired leases without allowing concurrent claims", () => {
    const feature = createCompletedFeature();
    const pending = database.enqueueFeatureCompletionReview(feature.id);
    const firstTime = new Date(pending.availableAt);
    const beforeExpiry = new Date(firstTime.getTime() + 4_999);
    const atExpiry = new Date(firstTime.getTime() + 5_000);

    const first = database.claimCompletionReview({ workerId: "worker-a", leaseMs: 5_000, now: firstTime });
    const concurrent = database.claimCompletionReview({
      workerId: "worker-b",
      leaseMs: 5_000,
      now: beforeExpiry
    });
    const recovered = database.claimCompletionReview({
      workerId: "worker-b",
      leaseMs: 5_000,
      now: atExpiry
    });

    expect(first?.status).toBe("running");
    expect(first?.attemptCount).toBe(1);
    expect(concurrent).toBeNull();
    expect(recovered?.leaseOwner).toBe("worker-b");
    expect(recovered?.attemptCount).toBe(2);
    expect(() => database.finishCompletionReview(first!.id, "worker-a", "succeeded")).toThrow("not claimed");
  });

  it("durably transitions through provider wait, retry, failure and success", () => {
    const feature = createCompletedFeature();
    const pending = database.enqueueFeatureCompletionReview(feature.id);
    expect(pending.status).toBe("pending");

    const running = database.claimCompletionReview({ workerId: "worker", leaseMs: 5_000 });
    expect(running?.status).toBe("running");
    expect(database.finishCompletionReview(running!.id, "worker", "waiting_provider").status)
      .toBe("waiting_provider");

    database.retryCompletionReview(running!.id);
    const second = database.claimCompletionReview({ workerId: "worker", leaseMs: 5_000 });
    const failed = database.finishCompletionReview(
      second!.id,
      "worker",
      "failed",
      `temporary failure ${["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_")} C:\\Users\\alice\\private\\repo`
    );
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toContain("[REDACTED_SECRET]");
    expect(failed.lastError).toContain("[REDACTED_LOCAL_PATH]");
    expect(containsSensitiveText(failed.lastError ?? "")).toBe(false);

    database.retryCompletionReview(second!.id);
    const third = database.claimCompletionReview({ workerId: "worker", leaseMs: 5_000 });
    const succeeded = database.finishCompletionReview(third!.id, "worker", "succeeded");
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.attemptCount).toBe(3);
    expect(succeeded.finishedAt).not.toBeNull();
  });

  it("accepts only completed Features with a reviewed head SHA", () => {
    database.registerProject({ key: "octomynd", path: tempDir });
    const feature = database.createFeature({
      projectKey: "octomynd",
      name: "Unreviewed feature",
      objective: "Must not enter completion review",
      branchName: "feature/unreviewed",
      worktreePath: tempDir,
      pullRequestUrl: "https://github.com/acme/repo/pull/99"
    });

    expect(() => database.enqueueFeatureCompletionReview(feature.id)).toThrow("must be completed");
    database.updateFeature({ id: feature.id, status: "completed" });
    expect(() => database.enqueueFeatureCompletionReview(feature.id)).toThrow("no reviewed head SHA");
  });

  it("adds the outbox without replacing data in an existing SQLite database", () => {
    database.close();
    databasePath = path.join(tempDir, "legacy.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        user_id TEXT,
        username TEXT,
        task_id INTEGER,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO events (source, type, text, task_id, created_at, metadata_json)
      VALUES ('legacy', 'legacy.event', 'preserve me', NULL, '2026-01-01T00:00:00.000Z', '{}');
    `);
    legacy.close();

    database = createDatabase(databasePath);

    expect(database.listEvents()[0].text).toBe("preserve me");
    const feature = createCompletedFeature();
    expect(database.enqueueFeatureCompletionReview(feature.id).status).toBe("pending");
  });
});

function createCompletedFeature(overrides: { objective?: string; reviewSummary?: string } = {}) {
  if (!database.findProjectByKey("octomynd")) {
    database.registerProject({ key: "octomynd", path: tempDir });
  }
  const feature = database.createFeature({
    projectKey: "octomynd",
    name: "Durable completion reviews",
    objective: overrides.objective ?? "Review completed work for reusable improvements",
    branchName: "feature/durable-completion-reviews",
    worktreePath: tempDir,
    pullRequestUrl: "https://github.com/acme/repo/pull/24"
  });
  return database.updateFeature({
    id: feature.id,
    status: "completed",
    reviewedHeadSha: "abc123-reviewed-head",
    reviewSummary: overrides.reviewSummary ?? "Final review passed",
    reviewerProvider: "codex",
    mergedAt: "2026-07-14T11:00:00.000Z"
  });
}
