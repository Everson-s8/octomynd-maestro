import path from "node:path";
import fs from "node:fs";
import http from "node:http";

export interface DesktopPaths {
  rootPath: string;
  uiDir: string;
  uiDistDir: string;
  distIndex: string;
  desktopEntry: string;
  viteConfig: string;
}

export interface DesktopCliOptions {
  skipBuild: boolean;
  port: number;
  host: string;
}

export function resolveDesktopPaths(baseDir?: string): DesktopPaths {
  const rootPath = baseDir ? path.resolve(baseDir) : process.cwd();
  const uiDir = path.join(rootPath, "ui");
  const uiDistDir = path.join(uiDir, "dist");
  const distIndex = path.join(uiDistDir, "index.html");
  const desktopEntry = path.join(rootPath, "src", "desktop", "index.js");
  const viteConfig = path.join(uiDir, "vite.config.ts");

  return {
    rootPath,
    uiDir,
    uiDistDir,
    distIndex,
    desktopEntry,
    viteConfig
  };
}

export function parseDesktopCliOptions(argv: string[]): DesktopCliOptions {
  const skipBuild = argv.includes("--skip-build");
  let port = 4787;
  let host = "127.0.0.1";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) {
      const p = parseInt(argv[i + 1], 10);
      if (!isNaN(p)) port = p;
    }
    if (argv[i] === "--host" && argv[i + 1]) {
      host = argv[i + 1];
    }
  }

  return { skipBuild, port, host };
}

export function isUiDistMissing(distIndexPath: string): boolean {
  return !fs.existsSync(distIndexPath);
}

export function isUiDistStale(uiDir: string, distIndexPath: string): boolean {
  if (isUiDistMissing(distIndexPath)) return true;

  try {
    const distStat = fs.statSync(distIndexPath);
    const srcDir = path.join(uiDir, "src");
    if (!fs.existsSync(srcDir)) return false;

    return hasFilesNewerThan(srcDir, distStat.mtimeMs);
  } catch {
    return true;
  }
}

function hasFilesNewerThan(dir: string, mtimeMs: number): boolean {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (hasFilesNewerThan(fullPath, mtimeMs)) return true;
    } else if (entry.isFile()) {
      const fileStat = fs.statSync(fullPath);
      if (fileStat.mtimeMs > mtimeMs) return true;
    }
  }
  return false;
}

export function checkViteConfigBase(viteConfigPath: string): { valid: boolean; base?: string } {
  if (!fs.existsSync(viteConfigPath)) {
    return { valid: false };
  }
  try {
    const content = fs.readFileSync(viteConfigPath, "utf8");
    const match = /base:\s*["']([^"']+)["']/.exec(content);
    if (match) {
      return { valid: match[1] === "./", base: match[1] };
    }
    return { valid: false };
  } catch {
    return { valid: false };
  }
}

export async function checkApiHealth(host = "127.0.0.1", port = 4787, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/api/health`, { timeout: timeoutMs }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}
