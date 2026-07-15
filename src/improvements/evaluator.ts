import crypto from "node:crypto";
import { redactSensitiveText } from "../security/redaction.js";
import { CandidateOrigin, CandidateProvenance } from "./provenance.js";
import {
  AllowedEvidence,
  CandidateDraft,
  CandidateFingerprintHook,
  EvaluationLimits,
  EvaluationReason,
  IMPROVEMENT_CATEGORIES,
  IMPROVEMENT_RISKS,
  ImprovementCategory,
  ImprovementRisk,
  SanitizedCandidateDraft
} from "./evaluation-types.js";

const EVALUATOR_VERSION = "1";
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const WHITESPACE = /\s+/g;
const RISK_ORDER: ImprovementRisk[] = ["low", "medium", "high"];

const CATEGORY_RISK_FLOORS: Record<ImprovementCategory, ImprovementRisk> = {
  skill: "low",
  memory: "low",
  routing: "medium",
  policy: "high",
  integration: "medium"
};

const DEFAULT_CONFIDENCE_FLOORS: Record<ImprovementRisk, number> = {
  low: 0.5,
  medium: 0.7,
  high: 0.85
};

export const DEFAULT_EVALUATION_LIMITS: EvaluationLimits = Object.freeze({
  maxTitleLength: 120,
  maxRationaleLength: 2_000,
  maxProposedChangeLength: 4_000,
  maxTargets: 8,
  maxTargetLength: 160,
  maxEvidence: 8,
  maxEvidenceIdLength: 128
});

const PROTECTED_TARGETS = [
  { name: "constitution", pattern: /(?:^|[\s/_.-])(?:constitution|constitui[cç][aã]o)(?:$|[\s/_.-])/i },
  { name: "secret filters", pattern: /(?:(?:secret|credential|token)[\s/_.-]*(?:filter|redact|handling|scan)|filtro[\s/_.-]*(?:de[\s/_.-]*)?(?:segredo|credencial))/i },
  { name: "human approval gates", pattern: /(?:(?:human[\s/_.-]*(?:approval|review)|aprova[cç][aã]o[\s/_.-]*humana)[\s/_.-]*(?:gates?|requirement|requisito)?)/i },
  { name: "audit log", pattern: /(?:(?:audit[\s/_.-]*(?:log|event|trail|persist))|(?:log|registro)[\s/_.-]*(?:de[\s/_.-]*)?auditoria)/i },
  { name: "filesystem permissions", pattern: /(?:(?:file[\s/_.-]*system|filesystem)[\s/_.-]*(?:permission|boundary|scope)|permiss(?:ion|[õo]es)[\s/_.-]*(?:de[\s/_.-]*)?(?:filesystem|sistema[\s/_.-]*de[\s/_.-]*arquivos))/i },
  { name: "tool permissions", pattern: /(?:(?:tool[\s/_.-]*(?:permission|boundary|allowlist|scope))|permiss(?:ion|[õo]es)[\s/_.-]*(?:de[\s/_.-]*)?ferramentas?)/i },
  { name: "rollback", pattern: /(?:(?:rollback|backups?|snapshot|revers[aã]o)[\s/_.-]*(?:mechanism|policy|guard|requirement|mecanismo)?)/i }
] as const;

export type EvaluateCandidateInput = {
  draft: CandidateDraft;
  allowedEvidence: readonly AllowedEvidence[];
  knownFingerprints?: ReadonlySet<string> | readonly string[];
  origin: CandidateOrigin;
  createdAt: string;
  evaluatedAt: string;
};

export type EvaluateCandidateOptions = {
  limits?: Partial<EvaluationLimits>;
  confidenceFloors?: Partial<Record<ImprovementRisk, number>>;
  fingerprint?: CandidateFingerprintHook;
};

export type CandidateEvaluation = {
  decision: "accepted" | "rejected";
  reasons: EvaluationReason[];
  candidate: SanitizedCandidateDraft;
  provenance: CandidateProvenance;
};

export function evaluateCandidate(
  input: EvaluateCandidateInput,
  options: EvaluateCandidateOptions = {}
): CandidateEvaluation {
  const limits = { ...DEFAULT_EVALUATION_LIMITS, ...options.limits };
  const confidenceFloors = { ...DEFAULT_CONFIDENCE_FLOORS, ...options.confidenceFloors };
  const reasons: EvaluationReason[] = [];
  const candidate = sanitizeCandidate(input.draft, limits);

  validateEnums(input.draft, reasons);
  validateFields(input.draft, candidate, limits, reasons);
  const evidence = validateEvidence(input.draft.evidenceIds, input.allowedEvidence, limits, reasons);
  validateProtectedChanges(candidate, reasons);

  const declaredRisk = isImprovementRisk(input.draft.risk) ? input.draft.risk : "high";
  const categoryFloor = isImprovementCategory(input.draft.category)
    ? CATEGORY_RISK_FLOORS[input.draft.category]
    : "high";
  const effectiveRisk = maximumRisk(declaredRisk, categoryFloor);
  validateConfidence(input.draft.confidence, effectiveRisk, confidenceFloors, reasons);

  if (effectiveRisk === "high" && evidence.sourceIds.length < 2) {
    reasons.push({
      code: "single_source_high_risk",
      message: "High-risk candidates require evidence from at least two independent sources.",
      field: "evidenceIds"
    });
  }

  const fingerprint = createFingerprint(candidate, options.fingerprint, reasons);
  const knownFingerprints = new Set(input.knownFingerprints ?? []);
  if (fingerprint && knownFingerprints.has(fingerprint)) {
    reasons.push({
      code: "duplicate_candidate",
      message: "A candidate with the same fingerprint already exists."
    });
  }

  return {
    decision: reasons.length === 0 ? "accepted" : "rejected",
    reasons,
    candidate,
    provenance: {
      origin: { ...input.origin },
      createdAt: input.createdAt,
      evaluatedAt: input.evaluatedAt,
      evaluatorVersion: EVALUATOR_VERSION,
      fingerprint,
      evidenceIds: [...evidence.ids],
      evidenceSourceIds: [...evidence.sourceIds],
      declaredRisk,
      effectiveRisk,
      confidence: Number.isFinite(input.draft.confidence) ? input.draft.confidence : 0
    }
  };
}

export function defaultCandidateFingerprint(candidate: SanitizedCandidateDraft): string {
  const canonical = {
    category: candidate.category,
    title: candidate.title.toLocaleLowerCase("en-US"),
    proposedChange: candidate.proposedChange,
    targets: [...candidate.targets].sort()
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function sanitizeCandidate(draft: CandidateDraft, limits: EvaluationLimits): SanitizedCandidateDraft {
  const targets = Array.isArray(draft.targets) ? draft.targets : [];
  const evidenceIds = Array.isArray(draft.evidenceIds) ? draft.evidenceIds : [];
  return {
    category: isImprovementCategory(draft.category) ? draft.category : "policy",
    title: sanitizeText(draft.title, limits.maxTitleLength),
    rationale: sanitizeText(draft.rationale, limits.maxRationaleLength),
    proposedChange: sanitizeText(draft.proposedChange, limits.maxProposedChangeLength),
    targets: targets.slice(0, limits.maxTargets).map((target) => sanitizeText(target, limits.maxTargetLength)),
    evidenceIds: evidenceIds
      .slice(0, limits.maxEvidence)
      .map((evidenceId) => sanitizeIdentifier(evidenceId, limits.maxEvidenceIdLength)),
    risk: isImprovementRisk(draft.risk) ? draft.risk : "high",
    confidence: Number.isFinite(draft.confidence) ? draft.confidence : 0
  };
}

function sanitizeText(value: string, maxLength: number): string {
  return redactSensitiveText(typeof value === "string" ? value : "")
    .replace(CONTROL_CHARACTERS, "")
    .replace(WHITESPACE, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeIdentifier(value: string, maxLength: number): string {
  return sanitizeText(value, maxLength);
}

function validateEnums(draft: CandidateDraft, reasons: EvaluationReason[]): void {
  if (!isImprovementCategory(draft.category)) {
    reasons.push({ code: "invalid_category", message: "Unsupported improvement category.", field: "category" });
  }
  if (!isImprovementRisk(draft.risk)) {
    reasons.push({ code: "invalid_risk", message: "Unsupported improvement risk.", field: "risk" });
  }
}

function validateFields(
  draft: CandidateDraft,
  candidate: SanitizedCandidateDraft,
  limits: EvaluationLimits,
  reasons: EvaluationReason[]
): void {
  const textFields = [
    ["title", draft.title, candidate.title, limits.maxTitleLength],
    ["rationale", draft.rationale, candidate.rationale, limits.maxRationaleLength],
    ["proposedChange", draft.proposedChange, candidate.proposedChange, limits.maxProposedChangeLength]
  ] as const;

  for (const [field, raw, sanitized, maxLength] of textFields) {
    if (!sanitized) reasons.push({ code: "missing_field", message: `${field} is required.`, field });
    if (typeof raw !== "string" || raw.length > maxLength) {
      reasons.push({ code: "field_too_large", message: `${field} exceeds its ${maxLength}-character limit.`, field });
    }
  }

  if (!Array.isArray(draft.targets) || draft.targets.length < 1 || draft.targets.length > limits.maxTargets) {
    reasons.push({
      code: "invalid_target_count",
      message: `Candidates require between 1 and ${limits.maxTargets} targets.`,
      field: "targets"
    });
  }
  if (Array.isArray(draft.targets) && draft.targets.some((target) => (
    typeof target !== "string" || !target.trim() || target.length > limits.maxTargetLength
  ))) {
    reasons.push({ code: "field_too_large", message: "Every target must be non-empty and within its size limit.", field: "targets" });
  }
}

function validateEvidence(
  evidenceIds: string[],
  allowedEvidence: readonly AllowedEvidence[],
  limits: EvaluationLimits,
  reasons: EvaluationReason[]
): { ids: string[]; sourceIds: string[] } {
  if (!Array.isArray(evidenceIds) || evidenceIds.length < 1 || evidenceIds.length > limits.maxEvidence) {
    reasons.push({
      code: "invalid_evidence_count",
      message: `Candidates require between 1 and ${limits.maxEvidence} evidence IDs.`,
      field: "evidenceIds"
    });
  }

  const allowedById = new Map(allowedEvidence.map((item) => [item.id, item]));
  const ids = (Array.isArray(evidenceIds) ? evidenceIds : [])
    .slice(0, limits.maxEvidence)
    .map((id) => typeof id === "string" ? id.trim() : "");
  if (new Set(ids).size !== ids.length) {
    reasons.push({ code: "duplicate_evidence", message: "Evidence IDs must be unique.", field: "evidenceIds" });
  }

  const validIds: string[] = [];
  const sourceIds = new Set<string>();
  for (const id of ids) {
    if (!id || id.length > limits.maxEvidenceIdLength || !allowedById.has(id)) {
      reasons.push({
        code: "evidence_not_allowed",
        message: `Evidence ID is not in the evaluator allowlist: ${sanitizeIdentifier(id, limits.maxEvidenceIdLength) || "(empty)"}.`,
        field: "evidenceIds"
      });
      continue;
    }
    validIds.push(sanitizeIdentifier(id, limits.maxEvidenceIdLength));
    sourceIds.add(sanitizeIdentifier(allowedById.get(id)!.sourceId, limits.maxEvidenceIdLength));
  }

  return { ids: [...new Set(validIds)], sourceIds: [...sourceIds].sort() };
}

function validateProtectedChanges(candidate: SanitizedCandidateDraft, reasons: EvaluationReason[]): void {
  const changeSurface = [candidate.title, candidate.proposedChange, ...candidate.targets].join("\n");
  for (const protectedTarget of PROTECTED_TARGETS) {
    if (protectedTarget.pattern.test(changeSurface)) {
      reasons.push({
        code: "protected_target",
        message: `Autonomous candidates cannot change ${protectedTarget.name}.`,
        field: "targets"
      });
    }
  }
}

function validateConfidence(
  confidence: number,
  effectiveRisk: ImprovementRisk,
  confidenceFloors: Record<ImprovementRisk, number>,
  reasons: EvaluationReason[]
): void {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    reasons.push({ code: "invalid_confidence", message: "Confidence must be between 0 and 1.", field: "confidence" });
    return;
  }
  if (confidence < confidenceFloors[effectiveRisk]) {
    reasons.push({
      code: "confidence_below_floor",
      message: `Confidence ${confidence} is below the ${confidenceFloors[effectiveRisk]} floor for ${effectiveRisk} risk.`,
      field: "confidence"
    });
  }
}

function createFingerprint(
  candidate: SanitizedCandidateDraft,
  hook: CandidateFingerprintHook | undefined,
  reasons: EvaluationReason[]
): string {
  let fingerprint = "";
  try {
    const generated = (hook ?? defaultCandidateFingerprint)(candidate);
    fingerprint = typeof generated === "string" ? generated.trim() : "";
  } catch {
    reasons.push({ code: "invalid_fingerprint", message: "The fingerprint hook failed." });
    return "";
  }
  if (!fingerprint || fingerprint.length > 128) {
    reasons.push({ code: "invalid_fingerprint", message: "The fingerprint hook returned an invalid fingerprint." });
    return "";
  }
  return fingerprint;
}

function maximumRisk(left: ImprovementRisk, right: ImprovementRisk): ImprovementRisk {
  return RISK_ORDER[Math.max(RISK_ORDER.indexOf(left), RISK_ORDER.indexOf(right))];
}

function isImprovementCategory(value: string): value is ImprovementCategory {
  return (IMPROVEMENT_CATEGORIES as readonly string[]).includes(value);
}

function isImprovementRisk(value: string): value is ImprovementRisk {
  return (IMPROVEMENT_RISKS as readonly string[]).includes(value);
}
