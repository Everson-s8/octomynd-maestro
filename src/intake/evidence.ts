import { WORK_INTAKE_POLICY_VERSION, WorkIntakeEvidencePack } from "./types.js";

export function buildWorkIntakeEvidencePack(
  subjectId: string,
  rawFacts: { key: string; value: string; field: string }[],
  now: string = new Date().toISOString()
): WorkIntakeEvidencePack {
  return {
    schemaVersion: 1,
    subject: {
      type: "work_intake",
      id: subjectId,
      policyVersion: WORK_INTAKE_POLICY_VERSION
    },
    capturedAt: now,
    facts: rawFacts.map((fact) => ({
      key: fact.key,
      value: fact.value,
      provenance: {
        sourceType: "work_intake",
        sourceId: subjectId,
        sourceVersion: String(WORK_INTAKE_POLICY_VERSION),
        field: fact.field
      }
    }))
  };
}
