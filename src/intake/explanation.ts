import { WorkIntakeDecision } from "./types.js";

export function explainWorkIntakeDecision(decision: WorkIntakeDecision): string {
  switch (decision.reasonCode) {
    case "single_bounded_objective":
      return "Demanda com objetivo único e delimitado. Classificada como Tarefa Direta.";
    case "coordination_required":
      return "Demanda requer coordenação de dependências ou múltiplos fluxos paralelos. Classificada como Plano de Funcionalidade.";
    case "multiple_acceptance_units":
      return "Demanda possui múltiplos critérios de aceite ou volume amplo de modificações. Classificada como Plano de Funcionalidade.";
    case "missing_objective":
      return "Objetivo ausente ou em branco. Necessita clarificação antes de prosseguir.";
    case "missing_acceptance_criteria":
      return "Objetivo vago sem critérios de aceite suficientes. Necessita clarificação.";
    case "explicit_override_direct_task":
      return "Sobrescrita explícita do usuário aplicada: Tarefa Direta.";
    case "explicit_override_feature_plan":
      return "Sobrescrita explícita do usuário aplicada: Plano de Funcionalidade.";
    case "explicit_override_needs_clarification":
      return "Sobrescrita explícita do usuário aplicada: Necessita Clarificação.";
    case "fallback_needs_clarification":
    default:
      return "Classificação incerta. Necessita clarificação.";
  }
}
