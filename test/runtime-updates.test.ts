import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, MaestroDatabase } from "../src/db.js";

let tempDir: string;
let database: MaestroDatabase;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-updates-test-"));
  database = createDatabase(path.join(tempDir, "maestro.db"));
  database.registerProject({ key: "maestro", name: "Octomynd Maestro", path: tempDir });
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("runtime_updates database table and idempotency", () => {
  it("enqueues a runtime update idempotently by featureId", () => {
    const update1 = database.enqueueRuntimeUpdate({
      featureId: 10,
      targetCommit: "abc123456",
      previousCommit: "000000000"
    });

    expect(update1.id).toBeGreaterThan(0);
    expect(update1.featureId).toBe(10);
    expect(update1.targetCommit).toBe("abc123456");
    expect(update1.status).toBe("pending");

    // Repeated enqueue with same featureId returns existing record without duplicate insertion
    const update2 = database.enqueueRuntimeUpdate({
      featureId: 10,
      targetCommit: "def789000",
      previousCommit: "111111111"
    });

    expect(update2.id).toBe(update1.id);
    expect(update2.targetCommit).toBe("abc123456");
    expect(database.listRuntimeUpdates()).toHaveLength(1);
  });

  it("updates status and error on a runtime update record", () => {
    const update = database.enqueueRuntimeUpdate({
      featureId: 20,
      targetCommit: "commit-sha-1",
      previousCommit: "commit-sha-0"
    });

    const updated = database.updateRuntimeUpdate({
      id: update.id,
      status: "in_progress"
    });

    expect(updated.status).toBe("in_progress");
    expect(updated.error).toBeNull();

    const failed = database.updateRuntimeUpdate({
      id: update.id,
      status: "failed",
      error: "Fast-forward merge failed."
    });

    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Fast-forward merge failed.");

    const latest = database.getLatestRuntimeUpdate();
    expect(latest?.id).toBe(update.id);
    expect(latest?.status).toBe("failed");
  });
});
