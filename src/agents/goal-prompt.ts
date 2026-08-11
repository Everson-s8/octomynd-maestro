import { formatLegacyPreviousSteps, formatTokenEfficientPreviousSteps } from "../runtime/compression.js";
import { formatSkillPromptContext } from "../skills/prompt.js";
import type { AgentExecutionRequest } from "./types.js";

export function buildAgentGoalPrompt(request: AgentExecutionRequest): string {
  const previous = request.previousStepHandoff
    ? formatTokenEfficientPreviousSteps(request.previousStepHandoff)
    : formatLegacyPreviousSteps(request.previousSteps);
  const phaseInstruction = {
    planning: "Inspecione o repositorio e produza um plano executavel. Nao edite arquivos.",
    implementing: "Implemente integralmente a task no workspace. Preserve o escopo.",
    testing: request.workerContext?.mode === "read_only"
      ? "Rode os testes relevantes e reporte falhas. Nao edite arquivos."
      : "Rode os testes relevantes. Corrija apenas falhas causadas pela task e valide novamente.",
    reviewing: [
      "Revise o diff, requisitos e testes. Nao edite.",
      "Solicite ajustes somente para problemas concretos.",
      "Finalize com uma linha exata: FINAL_REVIEW_DECISION: approved ou FINAL_REVIEW_DECISION: changes_requested.",
      "Se nao conseguir inspecionar todo o diff ou validar as evidencias, use changes_requested."
    ].join(" ")
  }[request.phase];

  return [
    "Voce e um worker do Octomynd Maestro executando uma goal persistente.",
    "Trabalhe autonomamente nesta etapa, sem pedir atualizacao manual da task.",
    "Use respostas estruturadas e tersas nos handoffs internos.",
    "Nao use estilo Caveman em decisoes de seguranca, review final, merge ou mensagens importantes ao usuario.",
    "Nunca faca commit, push, merge, deploy, altere credenciais ou saia do workspace.",
    `Projeto: ${request.project.name} (@${request.project.key})`,
    `Task #${request.task.id}: ${request.task.text}`,
    `Fase: ${request.phase}`,
    phaseInstruction,
    ...formatFeatureTaskContract(request.featureTaskContract),
    ...formatWorkerContext(request.workerContext),
    "",
    "Historico resumido das etapas:",
    previous,
    ...(request.resumeContext ? ["", "Checkpoint de retomada:", request.resumeContext] : []),
    ...formatSkillPromptContext(request.skillContext),
    ...(request.humanFeedback ? ["", "Ajustes solicitados pela pessoa responsavel:", request.humanFeedback] : []),
    "",
    "Entregue um resumo em portugues com arquivos alterados, testes, bloqueios e evidencias."
  ].join("\n");
}

export function parseFinalReviewDecision(content: string): "approved" | "changes_requested" | null {
  const matches = [...content.matchAll(/FINAL_REVIEW_DECISION:\s*[`"*]*\s*(approved|changes_requested)\b/gi)];
  if (matches.length !== 1) return null;
  return matches[0][1].toLowerCase() as "approved" | "changes_requested";
}

function formatFeatureTaskContract(contract: AgentExecutionRequest["featureTaskContract"]): string[] {
  if (!contract) return [];
  return [
    "",
    "Contrato desta Task na Feature:",
    `Objetivo: ${contract.objective}`,
    `Dependencias: ${contract.dependsOnTaskIds.length ? contract.dependsOnTaskIds.map((id) => `#${id}`).join(", ") : "nenhuma"}`,
    `Escopo de mutacao: ${contract.mutationScope.length ? contract.mutationScope.join(", ") : "somente leitura"}`,
    `Fora de escopo: ${contract.excludedScope.length ? contract.excludedScope.join(", ") : "nao especificado"}`,
    "Criterios de aceite:",
    ...contract.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "Nao amplie o escopo sem bloquear com evidencia concreta."
  ];
}

function formatWorkerContext(context: AgentExecutionRequest["workerContext"]): string[] {
  if (!context) return [];
  return [
    "",
    `Worker ${context.key} (${context.role}, ${context.mode})`,
    `Objetivo do Worker: ${context.objective}`,
    `Contrato de saida: ${context.outputContract}`,
    `Escopo de escrita: ${context.writeScope.length > 0 ? context.writeScope.join(", ") : "nenhum"}`,
    "Artifacts de entrada:",
    ...(context.inputArtifacts.length > 0
      ? context.inputArtifacts.map((artifact) => `- artifact:${artifact.key} - ${artifact.summary}`)
      : ["- nenhum"]),
    "Cumpra somente este contrato; nao absorva responsabilidades de outros Workers."
  ];
}
