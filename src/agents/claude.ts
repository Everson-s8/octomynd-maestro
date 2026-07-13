import fs from "node:fs";
import path from "node:path";
import { ProjectRecord, TaskRecord, TaskReviewStatus } from "../db.js";
import { buildRestrictedAgentEnvironment, runAgentProcess } from "./process.js";
import { buildFailureSummary, classifyFailure, isRetryableFailureCategory } from "./failure.js";
import { formatLegacyPreviousSteps, formatTokenEfficientPreviousSteps } from "../runtime/compression.js";
import {
  AgentCapability,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentHealth,
  AgentProvider
} from "./types.js";

export type ClaudeReviewResult = {
  status: TaskReviewStatus;
  content: string;
  error: string | null;
  durationMs: number;
};

export type ClaudeReviewer = (task: TaskRecord, project: ProjectRecord) => Promise<ClaudeReviewResult>;

type ClaudeCliCommand = {
  command: string;
  argsPrefix: string[];
};

const CLAUDE_CAPABILITIES = new Set<AgentCapability>([
  "planning",
  "coding",
  "testing",
  "reviewing",
  "research"
]);

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];
const REVIEW_TOOLS = [...READ_ONLY_TOOLS, "Bash"];
const REVIEW_ALLOWED_TOOLS = [
  ...READ_ONLY_TOOLS,
  "Bash(git diff*)",
  "Bash(git status*)",
  "Bash(git log*)",
  "Bash(git show*)"
];
const CODING_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write"];
const TESTING_TOOLS = [...CODING_TOOLS, "Bash"];
const TESTING_ALLOWED_TOOLS = [
  ...CODING_TOOLS,
  "Bash(git status*)",
  "Bash(git diff*)",
  "Bash(npm test*)",
  "Bash(npx vitest*)",
  "Bash(pytest*)",
  "Bash(python -m pytest*)",
  "Bash(cargo test*)",
  "Bash(go test*)"
];
const DISALLOWED_MUTATIONS = [
  "Bash(git commit*)",
  "Bash(git push*)",
  "Bash(git reset --hard*)",
  "Bash(git clean*)",
  "Bash(gh*)",
  "Bash(npm publish*)",
  "Bash(pnpm publish*)",
  "Bash(yarn npm publish*)",
  "Bash(docker push*)",
  "Bash(kubectl apply*)",
  "Bash(kubectl rollout*)",
  "Bash(terraform apply*)",
  "Bash(vercel*)",
  "Bash(netlify*)",
  "Bash(aws*)",
  "Bash(az*)",
  "Bash(gcloud*)",
  "Bash(curl*)",
  "Bash(wget*)"
];

export class ClaudeProvider implements AgentProvider {
  readonly id = "claude" as const;
  readonly label = "Claude";
  readonly capabilities = CLAUDE_CAPABILITIES;
  private cachedHealth: AgentHealth | null = null;
  private healthExpiresAt = 0;

  constructor(private readonly executionTimeoutMs = 20 * 60_000) {}

  async health(): Promise<AgentHealth> {
    if (this.cachedHealth && Date.now() < this.healthExpiresAt) return this.cachedHealth;
    const health: AgentHealth = resolveClaudeCliCommand()
      ? { state: "ready", detail: "Claude CLI disponivel", checkedAt: new Date().toISOString() }
      : { state: "offline", detail: "Claude CLI nao encontrado", checkedAt: new Date().toISOString() };
    this.cacheHealth(health, 30_000);
    return health;
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const result = await executeClaudeGoal(request, this.executionTimeoutMs);
    if (result.aborted || request.signal?.aborted) {
      return {
        outcome: "cancelled",
        summary: "Claude execution cancelled by user.",
        output: "",
        error: null,
        durationMs: result.durationMs,
        retryable: false
      };
    }
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      const errorText = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      const category = classifyFailure(errorText, result.timedOut);
      const retryable = isRetryableFailureCategory(category);
      const summary = buildFailureSummary(this.label, request.phase, category);
      this.cacheHealth({
        state: category === "auth_required" ? "auth_required" : category === "quota" ? "quota" : "offline",
        detail: summary,
        checkedAt: new Date().toISOString()
      }, retryable ? 10 * 60_000 : 30_000);
      return {
        outcome: "failed",
        summary,
        output: errorText,
        error: errorText || summary,
        durationMs: result.durationMs,
        retryable
      };
    }

    this.cacheHealth({
      state: "ready",
      detail: "Claude CLI autenticado",
      checkedAt: new Date().toISOString()
    }, 30_000);
    const content = result.stdout.trim();
    const reviewDecision = request.phase === "reviewing" ? parseClaudeReviewDecision(content) : null;
    const requestsChanges = request.phase === "reviewing" && reviewDecision !== "approved";
    return {
      outcome: requestsChanges ? "changes_requested" : "completed",
      summary: requestsChanges
        ? reviewDecision === "changes_requested"
          ? "Claude solicitou ajustes concretos."
          : "Claude nao aprovou explicitamente a revisao final."
        : `Claude concluiu a fase ${request.phase}.`,
      output: content,
      error: null,
      durationMs: result.durationMs,
      retryable: false
    };
  }

  private cacheHealth(health: AgentHealth, ttlMs: number) {
    this.cachedHealth = health;
    this.healthExpiresAt = Date.now() + ttlMs;
  }
}

export const reviewTaskWithClaude = async (
  task: TaskRecord,
  project: ProjectRecord,
  signal?: AbortSignal
): Promise<ClaudeReviewResult> => {
  const startedAt = Date.now();
  const cwd = task.worktreePath || project.path;
  const cli = resolveClaudeCliCommand();

  if (!cli) {
    return {
      status: "failed",
      content: "",
      error: "Claude Code CLI was not found in the global npm installation.",
      durationMs: Date.now() - startedAt
    };
  }

  if (!fs.existsSync(cwd)) {
    return {
      status: "failed",
      content: "",
      error: `Task workspace does not exist: ${cwd}`,
      durationMs: Date.now() - startedAt
    };
  }

  const args = [
    ...cli.argsPrefix,
    "--print",
    buildClaudeReviewPrompt(task, project),
    "--permission-mode",
    "plan",
    "--tools",
    "Read,Glob,Grep",
    "--add-dir",
    cwd,
    "--no-session-persistence"
  ];

  const result = await runAgentProcess({
    command: cli.command,
    args,
    cwd,
    timeoutMs: 180_000,
    signal,
    env: buildRestrictedAgentEnvironment()
  });
  const errorText = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();

  if (result.exitCode === 0 && result.stdout.trim()) {
    return {
      status: "completed",
      content: result.stdout.trim(),
      error: null,
      durationMs: Date.now() - startedAt
    };
  }

  const authenticationFailed = isClaudeAuthenticationError(errorText);
  return {
    status: authenticationFailed ? "auth_required" : "failed",
    content: "",
    error: authenticationFailed
      ? "Claude Code precisa ser reautenticado antes da revisao."
      : errorText || "Claude review failed without output.",
    durationMs: Date.now() - startedAt
  };
};

export function buildClaudeReviewPrompt(task: TaskRecord, project: ProjectRecord): string {
  return [
    "Voce e o revisor de produto e design do Octomynd Maestro.",
    "Trabalhe somente em modo leitura. Nao edite arquivos e nao execute comandos.",
    `Projeto: ${project.name} (@${project.key})`,
    `Task #${task.id}: ${task.text}`,
    "",
    "Analise o estado atual do repositorio e entregue em portugues:",
    "1. pontos fortes;",
    "2. problemas de UX, acessibilidade e coerencia visual;",
    "3. cinco melhorias priorizadas com arquivos/componentes afetados;",
    "4. riscos de implementar as mudancas;",
    "5. veredito curto: aprovado, aprovado com ajustes ou reprovado.",
    "Se existir docs/VISUAL_IDENTITY.md, use-o como contrato visual."
  ].join("\n");
}

export function buildClaudeGoalPrompt(request: AgentExecutionRequest): string {
  const previous = request.previousStepHandoff
    ? formatTokenEfficientPreviousSteps(request.previousStepHandoff)
    : formatLegacyPreviousSteps(request.previousSteps);
  const phaseInstruction = {
    planning: "Inspecione o repositorio e produza um plano executavel. Nao edite arquivos.",
    implementing: "Implemente integralmente a task no workspace. Preserve o escopo.",
    testing: "Rode os testes relevantes. Corrija apenas falhas causadas pela task e valide novamente.",
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
    "",
    "Historico resumido das etapas:",
    previous,
    ...(request.humanFeedback ? ["", "Ajustes solicitados pela pessoa responsavel:", request.humanFeedback] : []),
    "",
    "Entregue um resumo em portugues com arquivos alterados, testes, bloqueios e evidencias."
  ].join("\n");
}

export function buildClaudeGoalArgs(
  cli: ClaudeCliCommand,
  request: AgentExecutionRequest,
  cwd: string
): string[] {
  const writable = request.capability === "coding" || request.capability === "testing";
  const testing = request.capability === "testing";
  const reviewing = request.capability === "reviewing";
  const tools = testing ? TESTING_TOOLS : writable ? CODING_TOOLS : reviewing ? REVIEW_TOOLS : READ_ONLY_TOOLS;
  const allowedTools = testing ? TESTING_ALLOWED_TOOLS : reviewing ? REVIEW_ALLOWED_TOOLS : CODING_TOOLS;
  return [
    ...cli.argsPrefix,
    "--print",
    "--output-format",
    "text",
    "--permission-mode",
    writable ? "acceptEdits" : "plan",
    "--tools",
    tools.join(","),
    ...(writable || reviewing
      ? ["--allowedTools", allowedTools.join(","), "--disallowedTools", ...DISALLOWED_MUTATIONS]
      : []),
    "--add-dir",
    cwd,
    "--no-session-persistence",
    buildClaudeGoalPrompt(request)
  ];
}

export function parseClaudeReviewDecision(content: string): "approved" | "changes_requested" | null {
  const matches = [...content.matchAll(/FINAL_REVIEW_DECISION:\s*(approved|changes_requested)\b/gi)];
  if (matches.length !== 1) return null;
  return matches[0][1].toLowerCase() as "approved" | "changes_requested";
}

export function buildClaudeCliCommand(cliEntry: string): ClaudeCliCommand {
  return cliEntry.toLowerCase().endsWith(".js")
    ? { command: process.execPath, argsPrefix: [cliEntry] }
    : { command: cliEntry, argsPrefix: [] };
}

export function isClaudeAuthenticationError(errorText: string): boolean {
  return /401|authentication|credentials|not logged in|please run \/login|sign in/i.test(errorText);
}

export function isClaudeQuotaError(errorText: string): boolean {
  return /session limit|usage limit|rate limit|quota|resets? at/i.test(errorText);
}

async function executeClaudeGoal(request: AgentExecutionRequest, timeoutMs: number) {
  const cwd = request.task.worktreePath || request.project.path;
  const cli = resolveClaudeCliCommand();
  if (!cli || !fs.existsSync(cwd)) {
    return {
      exitCode: null,
      stdout: "",
      stderr: !cli ? "Claude Code CLI was not found." : `Task workspace does not exist: ${cwd}`,
      aborted: false,
      timedOut: false,
      durationMs: 0
    };
  }
  return runAgentProcess({
    command: cli.command,
    args: buildClaudeGoalArgs(cli, request, cwd),
    cwd,
    timeoutMs,
    signal: request.signal,
    env: buildRestrictedAgentEnvironment()
  });
}

function resolveClaudeCliCommand(): ClaudeCliCommand | null {
  const roots = [
    process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code")
      : "",
    process.env.NPM_CONFIG_PREFIX
      ? path.join(process.env.NPM_CONFIG_PREFIX, "node_modules", "@anthropic-ai", "claude-code")
      : ""
  ].filter(Boolean);
  const candidates = roots.flatMap((root) => [
    path.join(root, "bin", "claude.exe"),
    path.join(root, "cli.js")
  ]);
  const cliEntry = candidates.find((candidate) => fs.existsSync(candidate));
  return cliEntry ? buildClaudeCliCommand(cliEntry) : null;
}
