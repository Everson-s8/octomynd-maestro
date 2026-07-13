import fs from "node:fs";
import path from "node:path";

export type RtkDetection = {
  available: boolean;
  source: "path" | "npm_global" | "absent";
  command: string | null;
  argsPrefix: string[];
  detail: string;
  checkedAt: string;
};

const NPM_RTK_PACKAGES = [
  "rtk",
  "@octomynd/rtk",
  "@token-efficient/rtk"
];

const NPM_BIN_CANDIDATES = [
  ["bin", "rtk.js"],
  ["dist", "cli.js"],
  ["cli.js"]
];

export function detectLocalRtk(env: NodeJS.ProcessEnv = process.env): RtkDetection {
  const fromPath = findOnPath(env, "rtk");
  if (fromPath) return detection("path", fromPath, "RTK local encontrado no PATH.");

  const npmEntry = findNpmGlobalEntry(env);
  if (npmEntry) return detection("npm_global", npmEntry, "RTK local encontrado em instalacao npm global.");

  return {
    available: false,
    source: "absent",
    command: null,
    argsPrefix: [],
    detail: "RTK local nao encontrado; usando compressor interno.",
    checkedAt: new Date().toISOString()
  };
}

export function rtkDetectionForTelemetry(detection: RtkDetection): Omit<RtkDetection, "command" | "argsPrefix"> {
  return {
    available: detection.available,
    source: detection.source,
    detail: detection.detail,
    checkedAt: detection.checkedAt
  };
}

function detection(source: "path" | "npm_global", entry: string, detail: string): RtkDetection {
  const isJavaScriptEntry = entry.toLowerCase().endsWith(".js");
  return {
    available: true,
    source,
    command: isJavaScriptEntry ? process.execPath : entry,
    argsPrefix: isJavaScriptEntry ? [entry] : [],
    detail,
    checkedAt: new Date().toISOString()
  };
}

function findOnPath(env: NodeJS.ProcessEnv, commandName: string): string | null {
  const pathValue = env.PATH || env.Path || env.path || "";
  if (!pathValue.trim()) return null;
  const extensions = process.platform === "win32"
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const names = process.platform === "win32"
    ? [commandName, ...extensions.map((ext) => `${commandName}${ext.toLowerCase()}`)]
    : [commandName];

  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function findNpmGlobalEntry(env: NodeJS.ProcessEnv): string | null {
  const roots = [
    env.APPDATA ? path.join(env.APPDATA, "npm", "node_modules") : "",
    env.NPM_CONFIG_PREFIX ? path.join(env.NPM_CONFIG_PREFIX, "node_modules") : ""
  ].filter(Boolean);

  for (const root of roots) {
    for (const packageName of NPM_RTK_PACKAGES) {
      for (const entryParts of NPM_BIN_CANDIDATES) {
        const candidate = path.join(root, packageName, ...entryParts);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}
