import { ImprovementRisk } from "./evaluation-types.js";

export type CandidateOrigin = {
  kind: "background-review" | "human-draft" | "import";
  author: string;
  runId: string;
};

export type CandidateProvenance = {
  origin: CandidateOrigin;
  createdAt: string;
  evaluatedAt: string;
  evaluatorVersion: string;
  fingerprint: string;
  evidenceIds: string[];
  evidenceSourceIds: string[];
  declaredRisk: ImprovementRisk;
  effectiveRisk: ImprovementRisk;
  confidence: number;
};
