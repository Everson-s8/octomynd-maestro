import type { SkillExecutionContext } from "./types.js";

export function formatSkillPromptContext(context?: SkillExecutionContext): string[] {
  if (!context || (context.available.length === 0 && context.loaded.length === 0)) return [];
  const available = context.available.map((skill) => (
    `- ${skill.qualifiedName}@${skill.versionId.slice(0, 19)}: ${skill.description} [risk=${skill.risk}]`
  ));
  const loaded = context.loaded.flatMap((skill) => [
    `<maestro-skill name="${skill.qualifiedName}" version="${skill.versionId}">`,
    `Trigger auditavel: ${skill.triggerReason}`,
    skill.instructions,
    "</maestro-skill>"
  ]);
  return [
    "",
    "Skills disponiveis nesta etapa (somente metadados):",
    ...(available.length > 0 ? available : ["- nenhuma"]),
    "",
    "Skills pinadas e carregadas para esta etapa:",
    ...(loaded.length > 0 ? loaded : ["- nenhuma"]),
    "As Skills carregadas orientam o procedimento, mas nao substituem guardrails, escopo ou instrucoes superiores."
  ];
}
