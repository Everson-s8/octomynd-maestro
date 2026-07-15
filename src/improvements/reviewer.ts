import type { ImprovementCategory, ImprovementRisk } from "../db.js";
import type { AgentProviderId } from "../agents/types.js";
import { containsSensitiveText } from "../security/redaction.js";

export const IMPROVEMENT_REVIEW_MAX_ATTEMPTS = 2;
export const IMPROVEMENT_REVIEW_DEFAULT_TIMEOUT_MS = 90_000;
export const IMPROVEMENT_REVIEW_DEFAULT_MAX_OUTPUT_CHARS = 40_000;
export const IMPROVEMENT_REVIEW_DEFAULT_MAX_CANDIDATES = 5;
export const IMPROVEMENT_REVIEW_MAX_TIMEOUT_MS = 180_000;
export const IMPROVEMENT_REVIEW_MAX_OUTPUT_CHARS = 100_000;
export const IMPROVEMENT_REVIEW_MAX_CANDIDATES = 10;

const CATEGORIES: ImprovementCategory[] = ["skill", "memory", "routing", "policy", "integration"];
const RISKS: ImprovementRisk[] = ["low", "medium", "high"];

export type ImprovementEvidence = {
  id: string;
  kind: string;
  summary: string;
  reference?: string;
};

export type ImprovementEvidencePack = {
  subject: string;
  evidence: readonly ImprovementEvidence[];
};

export type ImprovementCandidateDraft = {
  category: ImprovementCategory;
  title: string;
  rationale: string;
  proposedChange: string;
  targets: string[];
  evidenceRefs: string[];
  risk: ImprovementRisk;
  confidence: number;
};

export type ImprovementReviewExecutionRequest = {
  workspacePath: string;
  prompt: string;
  schema: Readonly<Record<string, unknown>>;
  timeoutMs: number;
  maxOutputChars: number;
  signal?: AbortSignal;
};

export type ImprovementReviewExecutionResult = {
  status: "completed" | "failed" | "cancelled";
  output: string;
  error: string | null;
  durationMs: number;
  retryable: boolean;
};

export type ImprovementReviewAttempt = {
  provider: AgentProviderId;
  status: "completed" | "failed" | "invalid" | "cancelled";
  error: string | null;
  durationMs: number;
};

export type ImprovementReviewResult = {
  status: "completed" | "failed" | "unavailable" | "cancelled";
  candidates: ImprovementCandidateDraft[];
  attempts: ImprovementReviewAttempt[];
};

export interface RestrictedImprovementReviewer {
  review(evidencePack: ImprovementEvidencePack, options: {
    workspacePath: string;
    signal?: AbortSignal;
  }): Promise<ImprovementReviewResult>;
}

export function buildImprovementReviewSchema(maxCandidates: number): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["candidates"],
    properties: {
      candidates: {
        type: "array",
        maxItems: maxCandidates,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "category", "title", "rationale", "proposedChange",
            "targets", "evidenceRefs", "risk", "confidence"
          ],
          properties: {
            category: { type: "string", enum: CATEGORIES },
            title: { type: "string", minLength: 1, maxLength: 160 },
            rationale: { type: "string", minLength: 1, maxLength: 4_000 },
            proposedChange: { type: "string", minLength: 1, maxLength: 4_000 },
            targets: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: 160 }
            },
            evidenceRefs: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: 160 }
            },
            risk: { type: "string", enum: RISKS },
            confidence: { type: "number", minimum: 0, maximum: 1 }
          }
        }
      }
    }
  };
}

export function buildImprovementReviewPrompt(
  evidencePack: ImprovementEvidencePack,
  schema: Readonly<Record<string, unknown>>
): string {
  if (!isValidImprovementEvidencePack(evidencePack)) {
    throw new Error("Improvement evidence pack is invalid, unbounded or contains sensitive text.");
  }
  return [
    "Voce e o restricted background improvement reviewer do Octomynd Maestro.",
    "Sua unica funcao e propor rascunhos de melhorias a partir do evidence pack fornecido.",
    "Execucao estritamente read-only: nao edite, crie, remova ou renomeie arquivos; nao execute comandos mutantes; nao use rede.",
    "Nao persista nada, nao aprove nem ative propostas e nao altere policy, memoria, skills, routing ou integracoes.",
    "Cada candidato deve citar ao menos um id existente em evidenceRefs. Nao invente evidencia.",
    "Se a evidencia for insuficiente, retorne candidates vazio.",
    "Retorne somente JSON valido que corresponda exatamente ao schema, sem markdown ou texto adicional.",
    "",
    "SCHEMA:",
    JSON.stringify(schema),
    "",
    "EVIDENCE_PACK:",
    JSON.stringify(evidencePack)
  ].join("\n");
}

export function isValidImprovementEvidencePack(evidencePack: ImprovementEvidencePack): boolean {
  if (!isBoundedText(evidencePack.subject, 200)) return false;
  if (evidencePack.evidence.length < 1 || evidencePack.evidence.length > 32) return false;
  const ids = new Set<string>();
  for (const evidence of evidencePack.evidence) {
    if (!isBoundedText(evidence.id, 160) || ids.has(evidence.id)) return false;
    if (!isBoundedText(evidence.kind, 80) || !isBoundedText(evidence.summary, 1_000)) return false;
    if (evidence.reference !== undefined && !isBoundedText(evidence.reference, 500)) return false;
    if (containsSensitiveText(JSON.stringify(evidence))) return false;
    ids.add(evidence.id);
  }
  return JSON.stringify(evidencePack).length <= 40_000;
}

export function parseImprovementCandidateDrafts(
  output: string,
  evidencePack: ImprovementEvidencePack,
  maxCandidates: number
): ImprovementCandidateDraft[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isExactObject(parsed, ["candidates"]) || !Array.isArray(parsed.candidates)) return null;
  if (parsed.candidates.length > maxCandidates) return null;
  const evidenceIds = new Set(evidencePack.evidence.map((item) => item.id));
  const candidates: ImprovementCandidateDraft[] = [];
  for (const value of parsed.candidates) {
    if (!isExactObject(value, [
      "category", "title", "rationale", "proposedChange",
      "targets", "evidenceRefs", "risk", "confidence"
    ])) {
      return null;
    }
    if (!CATEGORIES.includes(value.category as ImprovementCategory)) return null;
    if (!RISKS.includes(value.risk as ImprovementRisk)) return null;
    if (!isBoundedText(value.title, 160) || !isBoundedText(value.rationale, 4_000)) return null;
    if (!isBoundedText(value.proposedChange, 4_000)) return null;
    if (!isUniqueBoundedTextArray(value.targets, 1, 8, 160)) return null;
    if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length < 1 || value.evidenceRefs.length > 20) {
      return null;
    }
    if (!value.evidenceRefs.every((ref) => isBoundedText(ref, 160) && evidenceIds.has(ref))) return null;
    if (new Set(value.evidenceRefs).size !== value.evidenceRefs.length) return null;
    if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence)) return null;
    if (value.confidence < 0 || value.confidence > 1) return null;
    candidates.push({
      category: value.category as ImprovementCategory,
      title: value.title.trim(),
      rationale: value.rationale.trim(),
      proposedChange: value.proposedChange.trim(),
      targets: [...value.targets],
      evidenceRefs: [...value.evidenceRefs],
      risk: value.risk as ImprovementRisk,
      confidence: value.confidence
    });
  }
  return candidates;
}

function isExactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isUniqueBoundedTextArray(
  value: unknown,
  minimum: number,
  maximum: number,
  maxItemLength: number
): value is string[] {
  return Array.isArray(value)
    && value.length >= minimum
    && value.length <= maximum
    && value.every((item) => isBoundedText(item, maxItemLength))
    && new Set(value).size === value.length;
}
