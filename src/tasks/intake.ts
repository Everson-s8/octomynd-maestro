export type TaskIntake = {
  title: string;
  specification: string;
};

/**
 * Turns a human request into stable display metadata while keeping the exact
 * request separately for auditability. This is intentionally deterministic:
 * the task must still be creatable when no provider is available.
 */
export function deriveTaskIntake(originalRequest: string): TaskIntake {
  const original = compact(originalRequest);
  const cleaned = stripFraming(original);
  const clause = firstClause(cleaned);
  const title = titleFromClause(clause || cleaned || original);
  return {
    title,
    specification: [
      `Objective: ${original}`,
      "",
      "Execution directive: inspect the existing context, implement only the necessary scope, validate the result, and record blockers or limitations with evidence."
    ].join("\n")
  };
}

export function deriveTaskTitle(originalRequest: string): string {
  return deriveTaskIntake(originalRequest).title;
}

function stripFraming(value: string): string {
  return value
    .replace(/^(?:fazer|criar)\s+(?:um|uma)\s+(projeto|sistema|aplicativo)\s+que\s+/i, "criar $1 ")
    .replace(/^(?:eu\s+)?(?:quero\s+)?(?:crie|criar|cadastrar|cadastre|abrir|abra|faca|faça)\s+(?:essa\s+)?task\s*[:\-,]?\s*/i, "")
    .replace(/^(?:eu\s+)?quero\s+criar\s+/i, "")
    .replace(/^(?:a ideia inicial é|a ideia e|objetivo|solicitação|solicitacao)\s*[:\-]?\s*/i, "")
    .replace(/^(?:fazer|fazê-lo|faze-lo)\s+/i, "")
    .replace(/\s+(?:faça|faca)\.?$/i, "")
    .trim();
}

function firstClause(value: string): string {
  const sentence = value.split(/(?<=[.!?])\s+/)[0] ?? value;
  return sentence.split(/,\s+|\s+\b(?:mas|porém|porem|e também|tambem)\b\s+/i)[0].trim();
}

function titleFromClause(value: string): string {
  let title = compact(value)
    .replace(/^(?:um|uma|o|a)\s+/i, "");

  if (/^(?:projeto|sistema|aplicativo)\b/i.test(title)) {
    title = `Criar ${title}`;
  } else if (/^(?:d[aá]\s+uma\s+olhada|verifique|investigue|analise|analisa)\b/i.test(title)) {
    title = `Revisar ${title.replace(/^(?:d[aá]\s+uma\s+olhada|verifique|investigue|analise|analisa)\s*/i, "")}`;
  } else if (/^(?:corrigir|consertar|resolver|ajustar|arrumar)\b/i.test(title)) {
    title = title.replace(/^(corrigir|consertar|resolver|ajustar|arrumar)\b/i, "Corrigir");
  } else if (/^(?:implementar|adicionar|criar|construir|fazer)\b/i.test(title)) {
    title = title.replace(/^(implementar|adicionar|criar|construir|fazer)\b/i, (verb) =>
      verb.toLowerCase() === "adicionar" ? "Adicionar" : verb.toLowerCase() === "implementar" ? "Implementar" : "Criar"
    );
  } else {
    title = `Atender: ${title}`;
  }

  title = capitalize(title.replace(/\s+/g, " ").trim());
  return truncate(title || "Atualizar projeto", 82);
}

function compact(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trim()}…`;
}
