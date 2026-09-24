import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export type ProjectEcosystem =
  | "node"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "dotnet"
  | "ruby"
  | "php"
  | "elixir"
  | "dart"
  | "swift"
  | "container";

export type ProjectManifestEvidence = {
  path: string;
  directory: string;
  name: string;
  ecosystem: ProjectEcosystem;
};

export type ProjectDiscovery = {
  root: string;
  /** Existing project files visible to Git (or all files for a non-Git folder). */
  files: string[];
  manifests: ProjectManifestEvidence[];
  ecosystems: ProjectEcosystem[];
  scannedDirectories: number;
  truncated: boolean;
  warnings: string[];
};

export type ProjectDiscoveryOptions = {
  maxDepth?: number;
  maxDirectories?: number;
};

const DEFAULT_MAX_DEPTH = 24;
const DEFAULT_MAX_DIRECTORIES = 20_000;
const IGNORED_DIRECTORIES = new Set([
  ".git", ".maestro", ".next", ".nuxt", ".pytest_cache", ".venv", ".vite",
  ".yarn", "__pycache__", "bin", "build", "coverage", "dist", "node_modules",
  "obj", "out", "target", "tmp", "temp", "venv", "vendor"
]);
const MAX_GIT_FILE_LIST_BYTES = 64 * 1024 * 1024;

/**
 * Inventories project manifests without inferring meaning from directory names.
 * Traversal is deterministic, bounded, and never follows symbolic links.
 */
export function discoverProject(rootPath: string, options: ProjectDiscoveryOptions = {}): ProjectDiscovery {
  const root = path.resolve(rootPath);
  const maxDepth = positiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH);
  const maxDirectories = positiveInteger(options.maxDirectories, DEFAULT_MAX_DIRECTORIES);
  const manifests: ProjectManifestEvidence[] = [];
  const warnings: string[] = [];
  const gitFiles = listGitVisibleFiles(root, maxDepth, maxDirectories);
  const inventory = gitFiles
    ? { files: gitFiles.files, scannedDirectories: gitFiles.scannedDirectories, truncated: gitFiles.truncated }
    : walkProjectFiles(root, maxDepth, maxDirectories, warnings);
  if (gitFiles) warnings.push(...gitFiles.warnings);
  const { files, scannedDirectories, truncated } = inventory;
  for (const relative of files) {
    const ecosystem = ecosystemForManifest(path.posix.basename(relative));
    if (!ecosystem) continue;
    manifests.push({
      path: relative,
      directory: path.posix.dirname(relative) === "." ? "." : path.posix.dirname(relative),
      name: path.posix.basename(relative),
      ecosystem
    });
  }
  if (truncated && !warnings.some((warning) => warning.includes("safety limit"))) {
    warnings.push(`Project discovery reached its maximum depth of ${maxDepth} or directory limit of ${maxDirectories}; deeper paths were not inspected.`);
  }
  manifests.sort((left, right) => left.path.localeCompare(right.path));
  return {
    root,
    files,
    manifests,
    ecosystems: [...new Set(manifests.map((manifest) => manifest.ecosystem))].sort(),
    scannedDirectories,
    truncated,
    warnings
  };
}

/**
 * In Git worktrees, use the repository's own index/ignore rules as the file
 * boundary. This prevents ignored build output, fixtures and generated apps
 * from being treated as projects to provision. Non-Git folders remain usable.
 */
function listGitVisibleFiles(root: string, maxDepth: number, maxDirectories: number): {
  files: string[];
  scannedDirectories: number;
  truncated: boolean;
  warnings: string[];
} | null {
  const prefixResult = spawnSync("git", ["-C", root, "rev-parse", "--show-prefix"], {
    encoding: "utf8", windowsHide: true, timeout: 10_000
  });
  if (prefixResult.status !== 0) {
    if (hasGitMetadataAncestor(root)) {
      return { files: [], scannedDirectories: 1, truncated: true, warnings: ["Could not inventory Git-visible project files; automatic project preparation is limited to prevent scanning ignored content."] };
    }
    return null;
  }

  const relativeRoot = String(prefixResult.stdout).trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const listed = spawnSync("git", ["-C", root, "ls-files", "--full-name", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "buffer", windowsHide: true, timeout: 15_000, maxBuffer: MAX_GIT_FILE_LIST_BYTES
  });
  if (listed.status !== 0 || listed.error) {
    return { files: [], scannedDirectories: 1, truncated: true, warnings: ["Could not inventory Git-visible project files; automatic project preparation is limited to prevent scanning ignored content."] };
  }

  const prefix = relativeRoot && relativeRoot !== "." ? `${relativeRoot}/` : "";
  const directories = new Set<string>(["."]);
  const files: string[] = [];
  let truncated = false;
  for (const item of Buffer.from(listed.stdout).toString("utf8").split("\0")) {
    if (!item || (prefix && !item.startsWith(prefix))) continue;
    const relative = prefix ? item.slice(prefix.length) : item;
    if (!relative || relative.split("/").some((part) => IGNORED_DIRECTORIES.has(part.toLowerCase()))) continue;
    const parts = relative.split("/");
    const depth = parts.length - 1;
    if (depth > maxDepth) {
      truncated = true;
      continue;
    }
    const absolute = path.join(root, ...parts);
    try {
      if (!fs.lstatSync(absolute).isFile()) continue;
    } catch {
      continue;
    }
    let relativeDirectory = ".";
    for (const part of parts.slice(0, -1)) {
      relativeDirectory = relativeDirectory === "." ? part : `${relativeDirectory}/${part}`;
      directories.add(relativeDirectory);
      if (directories.size >= maxDirectories) {
        truncated = true;
        break;
      }
    }
    if (directories.size >= maxDirectories && truncated) break;
    files.push(relative);
  }
  return {
    files: files.sort((left, right) => left.localeCompare(right)),
    scannedDirectories: directories.size,
    truncated,
    warnings: []
  };
}

function hasGitMetadataAncestor(root: string): boolean {
  let current = root;
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function walkProjectFiles(
  root: string,
  maxDepth: number,
  maxDirectories: number,
  warnings: string[]
): { files: string[]; scannedDirectories: number; truncated: boolean } {
  const files: string[] = [];
  const stack: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: root, relative: ".", depth: 0 }
  ];
  let scannedDirectories = 0;
  let truncated = false;
  while (stack.length > 0) {
    if (scannedDirectories >= maxDirectories) {
      truncated = true;
      warnings.push(`Project discovery stopped at its ${maxDirectories} directory safety limit.`);
      break;
    }
    const current = stack.pop()!;
    scannedDirectories += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.absolute, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      warnings.push(`Could not inspect ${current.relative}: ${error instanceof Error ? error.message : "unknown error"}`);
      continue;
    }
    for (const entry of entries) {
      const relative = current.relative === "." ? entry.name : `${current.relative}/${entry.name}`;
      if (entry.isFile()) {
        files.push(relative);
        continue;
      }
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      if (current.depth >= maxDepth) {
        truncated = true;
        continue;
      }
      stack.push({ absolute: path.join(current.absolute, entry.name), relative, depth: current.depth + 1 });
    }
  }
  return { files, scannedDirectories, truncated };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function ecosystemForManifest(fileName: string): ProjectEcosystem | null {
  const name = fileName.toLowerCase();
  if (name === "package.json" || name === "pnpm-workspace.yaml" || name === "deno.json" || name === "deno.jsonc") return "node";
  if (name === "pyproject.toml" || name === "pipfile" || name === "setup.py" || name === "setup.cfg"
    || name === "pytest.ini" || name === "tox.ini" || name === "environment.yml"
    || /^requirements(?:[-_.][^/]+)?\.txt$/.test(name)) return "python";
  if (name === "cargo.toml") return "rust";
  if (name === "go.mod") return "go";
  if (["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"].includes(name)) return "java";
  if (/\.(?:sln|csproj|fsproj|vbproj)$/.test(name)) return "dotnet";
  if (name === "gemfile") return "ruby";
  if (name === "composer.json") return "php";
  if (name === "mix.exs") return "elixir";
  if (name === "pubspec.yaml") return "dart";
  if (name === "package.swift") return "swift";
  if (name === "dockerfile" || name === "compose.yaml" || name === "compose.yml"
    || name === "docker-compose.yaml" || name === "docker-compose.yml") return "container";
  return null;
}
