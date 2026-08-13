import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  resolveDesktopPaths,
  parseDesktopCliOptions,
  isUiDistMissing,
  isUiDistStale,
  checkViteConfigBase
} from "../src/desktop/launcher.js";
import { getDesktopWindowOptions, resolveDesktopLoadUrl } from "../src/desktop/index.js";

describe("Desktop Launcher & Electron Entry", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-desktop-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("resolves desktop paths correctly relative to project root", () => {
    const paths = resolveDesktopPaths(tmpDir);
    expect(paths.rootPath).toBe(path.resolve(tmpDir));
    expect(paths.uiDir).toBe(path.join(path.resolve(tmpDir), "ui"));
    expect(paths.uiDistDir).toBe(path.join(path.resolve(tmpDir), "ui", "dist"));
    expect(paths.distIndex).toBe(path.join(path.resolve(tmpDir), "ui", "dist", "index.html"));
    expect(paths.desktopEntry).toBe(path.join(path.resolve(tmpDir), "src", "desktop", "index.js"));
    expect(paths.viteConfig).toBe(path.join(path.resolve(tmpDir), "ui", "vite.config.ts"));
  });

  it("parses CLI arguments for desktop launcher", () => {
    const defaultOpts = parseDesktopCliOptions([]);
    expect(defaultOpts.skipBuild).toBe(false);
    expect(defaultOpts.port).toBe(4787);
    expect(defaultOpts.host).toBe("127.0.0.1");

    const skipOpts = parseDesktopCliOptions(["--skip-build", "--port", "5000", "--host", "localhost"]);
    expect(skipOpts.skipBuild).toBe(true);
    expect(skipOpts.port).toBe(5000);
    expect(skipOpts.host).toBe("localhost");
  });

  it("correctly identifies missing ui/dist/index.html", () => {
    const paths = resolveDesktopPaths(tmpDir);
    expect(isUiDistMissing(paths.distIndex)).toBe(true);

    // Create file
    fs.mkdirSync(paths.uiDistDir, { recursive: true });
    fs.writeFileSync(paths.distIndex, "<html></html>");
    expect(isUiDistMissing(paths.distIndex)).toBe(false);
  });

  it("correctly detects stale ui/dist build", () => {
    const paths = resolveDesktopPaths(tmpDir);
    fs.mkdirSync(path.join(paths.uiDir, "src"), { recursive: true });
    fs.mkdirSync(paths.uiDistDir, { recursive: true });

    // Create dist/index.html with an old timestamp
    fs.writeFileSync(paths.distIndex, "<html></html>");
    const oldTime = new Date(Date.now() - 10000);
    fs.utimesSync(paths.distIndex, oldTime, oldTime);

    // Create a new file in ui/src
    const srcFile = path.join(paths.uiDir, "src", "App.tsx");
    fs.writeFileSync(srcFile, "// new content");

    expect(isUiDistStale(paths.uiDir, paths.distIndex)).toBe(true);
  });

  it("verifies Vite config base parameter", () => {
    const viteConfigPath = path.join(tmpDir, "vite.config.ts");
    expect(checkViteConfigBase(viteConfigPath).valid).toBe(false);

    fs.writeFileSync(viteConfigPath, `export default defineConfig({ base: "./" });`);
    const check = checkViteConfigBase(viteConfigPath);
    expect(check.valid).toBe(true);
    expect(check.base).toBe("./");
  });

  it("provides valid default window options for Electron BrowserWindow", () => {
    const opts = getDesktopWindowOptions();
    expect(opts.width).toBe(1280);
    expect(opts.height).toBe(800);
    expect(opts.title).toBe("Maestro");
    expect(opts.backgroundColor).toBe("#0f172a");
    expect(opts.webPreferences?.contextIsolation).toBe(true);
  });

  it("resolves the desktop window to the same-origin orchestrator URL (avoids file:// CORS)", () => {
    expect(resolveDesktopLoadUrl()).toBe("http://127.0.0.1:4787/");
    expect(resolveDesktopLoadUrl("127.0.0.1", "5000")).toBe("http://127.0.0.1:5000/");
    expect(resolveDesktopLoadUrl("localhost", "4787")).toBe("http://localhost:4787/");
  });
});
