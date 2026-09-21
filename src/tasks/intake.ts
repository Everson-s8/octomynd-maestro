export type TaskIntake = {
  title: string;
  specification: string;
};

/**
 * Turns a human request into stable display metadata while keeping the exact
 * request separately for auditability. This is intentionally deterministic:
 * the task must still be creatable when no provider is available.
 */
export function deriveTaskIntake(originalRequest: string, overrides: Partial<TaskIntake> = {}): TaskIntake {
  const original = compact(originalRequest);
  const cleaned = stripFraming(original);
  const clause = firstClause(cleaned);
  const title = titleFromClause(clause || cleaned || original);
  const suppliedTitle = compact(overrides.title ?? "");
  const suppliedSpecification = String(overrides.specification ?? "").trim();
  return {
    title: truncate(suppliedTitle || title, 120),
    specification: suppliedSpecification || defaultSpecification(original)
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
  return truncate(title || "Update project", 82);
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

function defaultSpecification(original: string): string {
  return [
    "## Context",
    "This task was derived from the user's project conversation. Preserve the original request as evidence and verify the current implementation before changing it. Separate current behavior, existing data/state, and the requested outcome.",
    "",
    "## Objective",
    original || "Clarify and implement the requested project change.",
    "",
    "## Scope",
    "Implement the behavior explicitly requested in the objective. Reuse the existing architecture and avoid unrelated changes or invented requirements.",
    "",
    "## Acceptance criteria",
    "- The requested objective is implemented in the existing project.",
    "- The result is understandable and actionable by the Maestro execution flow.",
    "- If the task changes data, persistence, startup, mocks, fixtures, or user-visible state, verify both a clean state and an already-used state; do not assume a fresh browser or empty database.",
    "- For UI or visual work, define the user flow, visual intent, required states, responsive/accessibility expectations, and rendered evidence before calling the surface complete.",
    "- Existing behavior outside this scope remains intact.",
    "",
    "## Validation",
    "- Inspect the relevant project context before implementation.",
    "- Run the focused tests, type checks, or build validation available for the changed area.",
    "- For user-visible, stateful, persistence, migration, mock, or startup changes, exercise the real runtime path and record evidence from both existing and clean state when applicable.",
    "- Record blockers, assumptions, and evidence if validation cannot be completed.",
    "",
    "## Constraints",
    "- Do not infer unrelated product requirements; surface material ambiguity instead of guessing."
  ].join("\n");
}
