import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactSensitiveText } from "../security/redaction.js";
import type { MaestroDatabase } from "../db.js";
import type { WorkerArtifactRecord, WorkerAttemptRecord, WorkerNodeRecord } from "./types.js";

export function writeWorkerResultArtifacts(input: {
  database: MaestroDatabase;
  artifactsRoot: string;
  graphId: number;
  runId: number;
  node: WorkerNodeRecord;
  attempt: WorkerAttemptRecord;
  summary: string;
  output: string;
}): WorkerArtifactRecord[] {
  const directory = path.resolve(
    input.artifactsRoot,
    `goal-${input.runId}`,
    `work-graph-${input.graphId}`,
    `node-${input.node.key}`,
    `attempt-${input.attempt.attemptNumber}`
  );
  const root = path.resolve(input.artifactsRoot);
  if (directory !== root && !directory.startsWith(`${root}${path.sep}`)) {
    throw new Error("Worker artifact directory escaped the configured root.");
  }
  fs.mkdirSync(directory, { recursive: true });
  const summary = redactSensitiveText(input.summary.trim()).slice(0, 2_000);
  const output = redactSensitiveText(input.output.trim()).slice(0, input.node.outputChars);
  const files = [
    { name: "handoff.md", kind: "handoff" as const, content: `# Worker handoff\n\n${summary}\n\n${output}\n` },
    {
      name: "result.json",
      kind: "report" as const,
      content: JSON.stringify({
        graphId: input.graphId,
        node: input.node.key,
        role: input.node.role,
        attempt: input.attempt.attemptNumber,
        provider: input.attempt.provider,
        summary
      }, null, 2)
    }
  ];
  return files.map((file) => {
    const filePath = path.join(directory, file.name);
    fs.writeFileSync(filePath, file.content, "utf8");
    const relativeKey = path.relative(root, filePath).replaceAll("\\", "/");
    return input.database.addWorkerArtifact({
      graphId: input.graphId,
      nodeId: input.node.id,
      attemptId: input.attempt.id,
      key: relativeKey,
      kind: file.kind,
      summary,
      contentHash: crypto.createHash("sha256").update(file.content).digest("hex"),
      bytes: Buffer.byteLength(file.content)
    });
  });
}

