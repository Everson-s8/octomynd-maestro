import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProject } from "../src/projects/discovery.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("discoverProject", () => {
  it("finds mixed project manifests at arbitrary paths without assigning meaning to folder names", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-project-discovery-"));
    const files = [
      "odd/place/service/package.json",
      "odd/place/service/requirements-prod.txt",
      "mobile/ios/Cargo.toml",
      "tools/worker/go.mod",
      "desktop/native/Octomynd.csproj",
      "odd/place/service/node_modules/ignored/package.json",
      "target/generated/Cargo.toml"
    ];
    for (const file of files) {
      const absolute = path.join(tempDir, file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, "{}\n", "utf8");
    }

    const discovery = discoverProject(tempDir);

    expect(discovery.manifests.map((manifest) => manifest.path)).toEqual([
      "desktop/native/Octomynd.csproj",
      "mobile/ios/Cargo.toml",
      "odd/place/service/package.json",
      "odd/place/service/requirements-prod.txt",
      "tools/worker/go.mod"
    ]);
    expect(discovery.ecosystems).toEqual(["dotnet", "go", "node", "python", "rust"]);
    expect(discovery.manifests.find((manifest) => manifest.path === "odd/place/service/package.json"))
      .toMatchObject({ directory: "odd/place/service", ecosystem: "node" });
    expect(discovery.truncated).toBe(false);
  });

  it("bounds traversal and reports when the project inventory is incomplete", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-project-discovery-"));
    fs.mkdirSync(path.join(tempDir, "level-one", "level-two"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "level-one", "level-two", "go.mod"), "module sample\n", "utf8");

    const discovery = discoverProject(tempDir, { maxDepth: 1 });

    expect(discovery.truncated).toBe(true);
    expect(discovery.warnings.join(" ")).toContain("maximum depth of 1");
    expect(discovery.manifests).toEqual([]);
  });
});
