import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MaestroDatabase, SkillVersionRecord } from "../db.js";
import { inspectSkillPackage } from "./catalog.js";
import type { SkillMetadata } from "./types.js";

export class SkillVersionStore {
  constructor(
    private readonly database: MaestroDatabase,
    private readonly rootPath: string
  ) {}

  register(metadata: SkillMetadata): SkillVersionRecord {
    const source = inspectSkillPackage(
      { scope: metadata.scope, path: path.dirname(metadata.packagePath), projectKey: metadata.projectKey },
      metadata.packagePath
    );
    assertSameVersion(metadata, source);
    const snapshotPath = this.ensureSnapshot(source);
    return this.database.registerSkillVersion({
      qualifiedName: source.qualifiedName,
      name: source.name,
      description: source.description,
      scope: source.scope,
      projectKey: source.projectKey,
      versionId: source.versionId,
      contentHash: source.contentHash,
      snapshotPath,
      policy: source.policy,
      fileCount: source.fileCount,
      totalBytes: source.totalBytes
    });
  }

  readSkillMarkdown(version: SkillVersionRecord): string {
    const verified = this.verifySnapshot(version);
    return fs.readFileSync(path.join(verified.packagePath, "SKILL.md"), "utf8");
  }

  verifySnapshot(version: SkillVersionRecord): SkillMetadata {
    const skill = this.database.getSkillByQualifiedName(version.qualifiedName);
    const snapshot = inspectSkillPackage(
      {
        scope: skill.scope,
        path: path.dirname(version.snapshotPath),
        projectKey: skill.projectKey
      },
      version.snapshotPath
    );
    if (snapshot.versionId !== version.versionId || snapshot.contentHash !== version.contentHash) {
      throw new Error(`Stored Skill snapshot failed integrity verification: ${version.qualifiedName}.`);
    }
    return snapshot;
  }

  private ensureSnapshot(metadata: SkillMetadata): string {
    const skillDirectory = path.join(this.rootPath, encodeQualifiedName(metadata.qualifiedName));
    const destination = path.join(skillDirectory, metadata.contentHash);
    fs.mkdirSync(skillDirectory, { recursive: true });
    if (fs.existsSync(destination)) {
      const existing = inspectSkillPackage(
        { scope: metadata.scope, path: skillDirectory, projectKey: metadata.projectKey },
        destination
      );
      assertSameVersion(metadata, existing);
      return destination;
    }

    const staging = `${destination}.tmp-${crypto.randomUUID()}`;
    try {
      fs.cpSync(metadata.packagePath, staging, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false
      });
      const copied = inspectSkillPackage(
        { scope: metadata.scope, path: skillDirectory, projectKey: metadata.projectKey },
        staging
      );
      assertSameVersion(metadata, copied);
      fs.renameSync(staging, destination);
      return destination;
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      if (fs.existsSync(destination)) {
        const existing = inspectSkillPackage(
          { scope: metadata.scope, path: skillDirectory, projectKey: metadata.projectKey },
          destination
        );
        assertSameVersion(metadata, existing);
        return destination;
      }
      throw error;
    }
  }
}

function encodeQualifiedName(qualifiedName: string): string {
  return qualifiedName.replaceAll(":", "--");
}

function assertSameVersion(expected: SkillMetadata, actual: SkillMetadata): void {
  if (
    expected.qualifiedName !== actual.qualifiedName
    || expected.versionId !== actual.versionId
    || expected.contentHash !== actual.contentHash
  ) {
    throw new Error(`Skill changed while creating its immutable snapshot: ${expected.qualifiedName}.`);
  }
}
