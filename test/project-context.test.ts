import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectProjectContext } from "../src/chat/project-context.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("inspectProjectContext project discovery", () => {
  it("reads nested project instructions and manifests without assuming conventional folders", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-project-context-"));
    fs.writeFileSync(path.join(tempDir, "README.md"), "A project with independent services.\n", "utf8");
    const serviceDir = path.join(tempDir, "odd", "structure", "video-engine");
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(path.join(serviceDir, "AGENTS.md"), "Keep the media pipeline local.\n", "utf8");
    fs.writeFileSync(path.join(serviceDir, "pyproject.toml"), "[project]\nname = 'video-engine'\n", "utf8");
    const clientDir = path.join(tempDir, "surprise", "client-app");
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(path.join(clientDir, "package.json"), "{\"name\":\"client-app\"}\n", "utf8");

    const context = inspectProjectContext(tempDir, "Study the project architecture and structure");

    expect(context.files.map((file) => file.path)).toContain("odd/structure/video-engine/AGENTS.md");
    expect(context.files.map((file) => file.path)).toContain("odd/structure/video-engine/pyproject.toml");
    expect(context.files.map((file) => file.path)).toContain("surprise/client-app/package.json");
    expect(context.summaryText).toContain("Manifest evidence: node, python");
  });
});
