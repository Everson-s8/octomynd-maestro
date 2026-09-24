import fs from "node:fs";
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
        const ecosystem = ecosystemForManifest(entry.name);
        if (ecosystem) manifests.push({ path: relative, directory: current.relative, name: entry.name, ecosystem });
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

  if (truncated && !warnings.some((warning) => warning.includes("safety limit"))) {
    warnings.push(`Project discovery reached its maximum depth of ${maxDepth}; deeper directories were not inspected.`);
  }
  manifests.sort((left, right) => left.path.localeCompare(right.path));
  return {
    root,
    manifests,
    ecosystems: [...new Set(manifests.map((manifest) => manifest.ecosystem))].sort(),
    scannedDirectories,
    truncated,
    warnings
  };
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
