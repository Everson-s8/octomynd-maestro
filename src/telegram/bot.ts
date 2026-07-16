import { Bot, Context } from "grammy";
import { MaestroConfig } from "../config.js";
import { FeaturePlanDetails, FeatureRecord, MaestroDatabase, ProjectRecord, TaskRecord } from "../db.js";
import { parseProjectTaskInput } from "../orchestrator.js";
import { ApplicationCommands } from "../commands/application-commands.js";
import { ApplicationCommandError } from "../commands/errors.js";
import { CommandOrigin } from "../commands/types.js";
import { BacklogAutopilotSnapshot } from "../backlog/autopilot.js";
import { FeatureGitHubGateway } from "../features/github.js";
import type { EnvironmentDoctorReport } from "../environment/types.js";
import type { AgentProviderSnapshot } from "../agents/registry.js";

export type TelegramBotOptions = {
  cancelTask?: (taskId: number) => TaskRecord;
  autopilotStatus?: () => BacklogAutopilotSnapshot | null;
  featureGithub?: FeatureGitHubGateway;
  environmentDoctor?: (projectKey: string) => Promise<EnvironmentDoctorReport>;
  providerStatus?: () => Promise<AgentProviderSnapshot[]>;
};

export function createTelegramBot(
  config: MaestroConfig,
  database: MaestroDatabase,
  options: TelegramBotOptions = {}
) {
  const bot = new Bot(config.telegram.botToken);
  const commands = new ApplicationCommands(database, options.featureGithub);

  bot.use(async (ctx, next) => {
    if (isUserAllowed(ctx.from?.id, config.telegram.allowedUserId)) {
      return next();
    }

    database.addEvent({
      source: "telegram",
      type: "auth.denied",
      text: "Unauthorized Telegram user attempted access.",
      userId: ctx.from?.id ? String(ctx.from.id) : null,
      username: ctx.from?.username ?? null
    });

    await ctx.reply("Acesso nao autorizado para este Maestro.");
  });

  bot.command("start", async (ctx) => {
    database.addEvent({
      source: "telegram",
      type: "command.start",
      text: "/start",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null
    });

    await ctx.reply(formatHelp());
  });

  bot.command("help", async (ctx) => {
    database.addEvent({
      source: "telegram",
      type: "command.help",
      text: "/help",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null
    });

    await ctx.reply(formatHelp());
  });

  bot.command("status", async (ctx) => {
    const projectKey = parseStatusProjectKey(ctx.message?.text ?? "");
    database.addEvent({
      source: "telegram",
      type: "command.status",
      text: "/status",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null
    });

    if (projectKey && !database.findProjectByKey(projectKey)) {
      await ctx.reply(`Projeto @${projectKey} nao encontrado.`);
      return;
    }
    const providers = options.providerStatus ? await options.providerStatus() : [];
    await ctx.reply(formatStatus(
      config.projectName,
      database,
      projectKey,
      options.autopilotStatus?.() ?? null,
      providers
    ));
  });

  bot.command("projects", async (ctx) => {
    database.addEvent({
      source: "telegram",
      type: "command.projects",
      text: "/projects",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null
    });

    await ctx.reply(formatProjects(database.listProjects()));
  });

  bot.command("doctor", async (ctx) => {
    if (!options.environmentDoctor) {
      await ctx.reply("Environment Doctor indisponivel.");
      return;
    }
    const requestedKey = parseDoctorProjectKey(ctx.message?.text ?? "");
    const project = requestedKey ? database.findProjectByKey(requestedKey) : database.getDefaultProject();
    if (!project) {
      await ctx.reply(requestedKey ? `Projeto @${requestedKey} nao encontrado.` : "Nenhum projeto cadastrado.");
      return;
    }
    const report = await options.environmentDoctor(project.key);
    await ctx.reply(formatEnvironmentReport(report));
  });

  bot.command("project_add", async (ctx) => {
    const input = parseProjectAddText(ctx.message?.text ?? "");
    if (!input) {
      await ctx.reply("Use: /project_add chave caminho-do-repo");
      return;
    }

    let result;
    try {
      result = commands.registerProject(telegramOrigin(ctx), input);
    } catch (error) {
      await ctx.reply(["Projeto nao cadastrado.", ...commandErrorDetails(error)].join("\n"));
      return;
    }

    const lines = [
      `Projeto ${result.project.key} cadastrado.`,
      `Nome: ${result.project.name}`,
      `Branch padrao: ${result.project.defaultBranch}`
    ];

    if (result.warnings.length > 0) {
      lines.push("", ...result.warnings);
    }

    await ctx.reply(lines.join("\n"));
  });

  bot.command("task", async (ctx) => {
    const taskInput = parseProjectTaskInput(parseTaskText(ctx.message?.text ?? ""));
    if (!taskInput.text) {
      await ctx.reply("Use: /task @projeto descrever a demanda");
      return;
    }

    let task: TaskRecord;
    try {
      task = commands.createTask(telegramOrigin(ctx), {
        text: taskInput.text,
        projectKey: taskInput.projectKey
      });
    } catch (error) {
      if (error instanceof ApplicationCommandError && error.code === "not_found") {
        await ctx.reply("Nenhum projeto cadastrado. Use /project_add chave caminho-do-repo.");
        return;
      }
      await ctx.reply(["Task nao criada.", ...commandErrorDetails(error)].join("\n"));
      return;
    }

    await ctx.reply(
      [
        `Task #${task.id} criada.`,
        `Projeto: ${task.projectKey}`,
        `Estado: ${task.status}`,
        `Demanda: ${task.text}`
      ].join("\n")
    );
  });

  bot.command("queue", async (ctx) => {
    const projectKey = parseQueueProjectKey(ctx.message?.text ?? "");
    database.addEvent({
      source: "telegram",
      type: "command.queue",
      text: "/queue",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null,
      metadata: { projectKey }
    });

    const tasks = projectKey ? database.listTasksByProject(projectKey, 10) : database.listTasks(10);
    await ctx.reply(formatQueue(tasks));
  });

  bot.command("graphs", async (ctx) => {
    const projectKey = parseNamedProjectKey(ctx.message?.text ?? "", "graphs");
    if (projectKey && !database.findProjectByKey(projectKey)) {
      await ctx.reply(`Projeto @${projectKey} nao encontrado.`);
      return;
    }
    database.addEvent({
      source: "telegram",
      type: "command.graphs",
      text: "/graphs",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null,
      metadata: { projectKey }
    });
    await ctx.reply(formatWorkGraphs(database, commands.listWorkGraphs(10), projectKey));
  });

  bot.command("graph_cancel", async (ctx) => {
    const graphId = parseTaskId(ctx.message?.text ?? "", "graph_cancel");
    if (!graphId) {
      await ctx.reply("Use: /graph_cancel id");
      return;
    }
    try {
      const graph = commands.cancelWorkGraph(telegramOrigin(ctx), graphId, "Cancelado pelo Telegram.");
      await ctx.reply(`Work Graph #${graph.id} cancelado. Artefatos e historico foram preservados.`);
    } catch (error) {
      await ctx.reply(["Cancelamento do Work Graph nao aplicado.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command("prepare", async (ctx) => {
    const taskId = parseTaskId(ctx.message?.text ?? "", "prepare");
    if (!taskId) {
      await ctx.reply("Use: /prepare 2");
      return;
    }

    let result;
    try {
      result = commands.prepareTask(telegramOrigin(ctx), taskId, config.worktreesPath);
    } catch (error) {
      await ctx.reply(["Prepare falhou.", ...commandErrorDetails(error)].join("\n"));
      return;
    }

    await ctx.reply(
      [
        `Task #${result.task.id} preparada.`,
        `Estado: ${result.task.status}`,
        `Branch: ${result.branchName}`,
        "Worktree isolada preparada."
      ].join("\n")
    );
  });

  bot.command("cancel", async (ctx) => {
    await ctx.reply(executeCancelCommand(ctx.message?.text ?? "", options.cancelTask));
  });

  bot.command("improvements", async (ctx) => {
    const candidates = database.listImprovementProposals(20).filter((item) => item.status === "candidate");
    await ctx.reply(formatImprovementCandidates(candidates));
  });

  bot.command("improve_approve", async (ctx) => {
    const improvementId = parseTaskId(ctx.message?.text ?? "", "improve_approve");
    if (!improvementId) {
      await ctx.reply("Use: /improve_approve id");
      return;
    }
    try {
      const result = commands.decideImprovementProposal(telegramOrigin(ctx), improvementId, "approved");
      await ctx.reply([
        `Melhoria #${result.improvement.id} aprovada sem mutacao direta.`,
        `Task criada: #${result.task?.id}`,
        `Feature Plan criado: #${result.featurePlan?.plan.id}`,
        "O backlog normal assumira a implementacao e o PR consolidado continuara sendo o gate final."
      ].join("\n"));
    } catch (error) {
      await ctx.reply(["Aprovacao nao aplicada.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command("improve_reject", async (ctx) => {
    const improvementId = parseTaskId(ctx.message?.text ?? "", "improve_reject");
    if (!improvementId) {
      await ctx.reply("Use: /improve_reject id");
      return;
    }
    try {
      const result = commands.decideImprovementProposal(telegramOrigin(ctx), improvementId, "rejected");
      await ctx.reply(`Melhoria #${result.improvement.id} rejeitada e preservada para auditoria.`);
    } catch (error) {
      await ctx.reply(["Rejeicao nao aplicada.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command("features", async (ctx) => {
    const projectKey = parseFeaturesProjectKey(ctx.message?.text ?? "");
    database.addEvent({
      source: "telegram",
      type: "command.features",
      text: "/features",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null,
      metadata: { projectKey }
    });

    if (projectKey && !database.findProjectByKey(projectKey)) {
      await ctx.reply(`Projeto @${projectKey} nao encontrado.`);
      return;
    }

    const plans = commands.listFeaturePlans(projectKey, 10);
    const features = database.listFeatures(30).filter((feature) => !projectKey || feature.projectKey === projectKey);
    await ctx.reply(formatFeatures(database, plans, features));
  });

  bot.command("feature_cancel", async (ctx) => {
    const parsed = parseFeatureCancelText(ctx.message?.text ?? "");
    if (!parsed) {
      await ctx.reply("Use: /feature_cancel id [motivo]");
      return;
    }

    let feature: FeatureRecord;
    try {
      feature = await commands.cancelFeature(telegramOrigin(ctx), parsed.featureId, parsed.reason);
    } catch (error) {
      await ctx.reply(["Cancelamento nao aplicado.", ...commandErrorDetails(error)].join("\n"));
      return;
    }

    await ctx.reply(
      [
        `Feature #${feature.id} cancelada.`,
        `Estado: ${feature.status}`,
        "O PR consolidado e o historico continuam disponiveis para auditoria.",
        `PR: ${feature.pullRequestUrl}`
      ].join("\n")
    );
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();

    if (text.startsWith("/")) {
      database.addEvent({
        source: "telegram",
        type: "command.unknown",
        text,
        userId: String(ctx.from?.id ?? ""),
        username: ctx.from?.username ?? null
      });
      await ctx.reply("Comando nao reconhecido. Use /help.");
      return;
    }

    database.addEvent({
      source: "telegram",
      type: "feedback.received",
      text,
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null
    });

    await ctx.reply("Feedback recebido e registrado.");
  });

  return bot;
}

function telegramOrigin(ctx: Context): CommandOrigin {
  return {
    channel: "telegram",
    userId: String(ctx.from?.id ?? ""),
    username: ctx.from?.username ?? null
  };
}

function commandErrorDetails(error: unknown): string[] {
  if (error instanceof ApplicationCommandError) {
    return error.details;
  }
  return [error instanceof Error ? error.message : "Erro desconhecido."];
}

export function parseTaskText(messageText: string): string {
  return messageText.replace(/^\/task(?:@\w+)?\s*/i, "").trim();
}

export function parseProjectAddText(
  messageText: string
): { key: string; path: string; defaultBranch?: string } | null {
  const text = messageText.replace(/^\/project_add(?:@\w+)?\s*/i, "").trim();
  const match = text.match(/^([a-z0-9][a-z0-9_-]{1,48})\s+(.+)$/i);

  if (!match) {
    return null;
  }

  return {
    key: match[1].toLowerCase(),
    path: match[2].trim()
  };
}

export function parseQueueProjectKey(messageText: string): string | null {
  const text = messageText.replace(/^\/queue(?:@\w+)?\s*/i, "").trim();
  const match = text.match(/^@?([a-z0-9][a-z0-9_-]{1,48})$/i);
  return match ? match[1].toLowerCase() : null;
}

export function parseStatusProjectKey(messageText: string): string | null {
  const text = messageText.replace(/^\/status(?:@\w+)?\s*/i, "").trim();
  if (!text) return null;
  const match = text.match(/^@?([a-z0-9][a-z0-9_-]{1,48})$/i);
  return match ? match[1].toLowerCase() : null;
}

function parseNamedProjectKey(messageText: string, command: string): string | null {
  const text = messageText.replace(new RegExp(`^/${command}(?:@\\w+)?\\s*`, "i"), "").trim();
  if (!text) return null;
  const match = text.match(/^@?([a-z0-9][a-z0-9_-]{1,48})$/i);
  return match ? match[1].toLowerCase() : null;
}

export function parseTaskId(messageText: string, command: string): number | null {
  const regex = new RegExp(`^/${command}(?:@\\w+)?\\s+(\\d+)\\s*$`, "i");
  const match = messageText.match(regex);
  return match ? Number(match[1]) : null;
}

export function parseFeaturesProjectKey(messageText: string): string | null {
  const text = messageText.replace(/^\/features(?:@\w+)?\s*/i, "").trim();
  if (!text) return null;
  const match = text.match(/^@?([a-z0-9][a-z0-9_-]{1,48})$/i);
  return match ? match[1].toLowerCase() : null;
}

export function parseDoctorProjectKey(messageText: string): string | null {
  const text = messageText.replace(/^\/doctor(?:@\w+)?\s*/i, "").trim();
  if (!text) return null;
  const match = text.match(/^@?([a-z0-9][a-z0-9_-]{1,48})$/i);
  return match ? match[1].toLowerCase() : null;
}

export function parseFeatureCancelText(
  messageText: string
): { featureId: number; reason: string | null } | null {
  const match = messageText.match(/^\/feature_cancel(?:@\w+)?\s+(\d+)(?:\s+(.+))?\s*$/i);
  if (!match) return null;
  return { featureId: Number(match[1]), reason: match[2]?.trim() || null };
}

export function executeCancelCommand(
  messageText: string,
  cancelTask?: (taskId: number) => TaskRecord
): string {
  const taskId = parseTaskId(messageText, "cancel");
  if (!taskId) return "Use: /cancel 2";
  if (!cancelTask) return "Cancelamento indisponivel neste runtime.";
  try {
    const task = cancelTask(taskId);
    return `Task #${task.id} cancelada. Estado: ${task.status}.`;
  } catch (error) {
    return error instanceof Error ? error.message : "Nao foi possivel cancelar a task.";
  }
}

export function isUserAllowed(userId: number | undefined, allowedUserId: string | null): boolean {
  if (!allowedUserId) {
    return true;
  }
  return userId !== undefined && String(userId) === allowedUserId;
}

export function formatStatus(
  projectName: string,
  database: MaestroDatabase,
  projectKey: string | null = null,
  autopilot: BacklogAutopilotSnapshot | null = null,
  providers: AgentProviderSnapshot[] = []
): string {
  const counts = database.countTasksByStatus();
  const lastEvent = database.getLastEvent();
  const projects = database.listProjects();
  const tasks = projectKey ? database.listTasksByProject(projectKey, 40) : database.listTasks(40);
  const taskIds = new Set(tasks.map((task) => task.id));
  const activeGoals = database.listGoalRuns(100).filter(
    (goal) => taskIds.has(goal.taskId) && ["running", "waiting_provider"].includes(goal.status)
  );
  const working = activeGoals.map((goal) => {
    const task = database.getTask(goal.taskId);
    const provider = database.listGoalSteps(goal.id).at(-1)?.provider ?? "roteando agente";
    return `- #${task.id} @${task.projectKey ?? "inbox"}: ${provider} em ${goal.currentPhase} (${goal.stepCount}/${goal.maxSteps})`;
  });
  const activeGraphs = database.listWorkGraphs(30).filter((graph) => {
    if (!["draft", "validated", "running", "waiting_provider"].includes(graph.status)) return false;
    if (!projectKey) return true;
    const task = database.getTask(database.getGoalRun(graph.runId).taskId);
    return task.projectKey === projectKey;
  });

  return [
    `Maestro: online`,
    projectKey ? `Projeto: @${projectKey}` : `Workspace: ${projectName}`,
    `Projetos: ${projects.length}`,
    `Tasks ativas: ${tasks.filter((task) => !["done", "failed", "rejected", "blocked", "cancelled"].includes(task.status)).length}`,
    ...(projectKey ? [] : [
      `Tasks queued: ${counts.queued ?? 0}`,
      `Tasks awaiting_human: ${counts.awaiting_human ?? 0}`,
      `Tasks done: ${counts.done ?? 0}`
    ]),
    ...(autopilot ? [
      `Autopilot: ${autopilot.enabled ? autopilot.state : "disabled"}`,
      `Autopilot slots: ${autopilot.runningGoals}/${autopilot.maxConcurrentGoals}; waiting_provider: ${autopilot.waitingProviderGoals}`
    ] : []),
    "",
    "Trabalhando agora:",
    ...(working.length > 0 ? working : ["- nenhum agente executando"]),
    ...(activeGraphs.length > 0 ? [
      "",
      "Work Graphs:",
      ...activeGraphs.map((graph) => (
        `- graph #${graph.id} [${graph.status}] ${graph.nodes.filter((node) => node.status === "completed").length}/${graph.nodes.length} nodes`
      ))
    ] : []),
    ...(providers.length > 0 ? [
      "",
      "Providers:",
      ...providers.map((provider) => (
        `- ${provider.label}: ${provider.state}${provider.activeCount > 0 ? ` (${provider.activeCount} ativo)` : ""} - ${provider.detail}`
      ))
    ] : []),
    "",
    `Ultimo evento: ${lastEvent ? `${lastEvent.type} em ${lastEvent.createdAt}` : "nenhum"}`
  ].join("\n");
}

export function formatProjects(projects: ProjectRecord[]): string {
  if (projects.length === 0) {
    return "Nenhum projeto cadastrado. Use /project_add chave caminho-do-repo.";
  }

  return projects
    .map((project) => `${project.key} -> ${project.name} (${project.defaultBranch})`)
    .join("\n");
}

export function formatQueue(tasks: TaskRecord[]): string {
  if (tasks.length === 0) {
    return "Fila vazia.";
  }

  return tasks
    .map((task) => `#${task.id} ${task.projectKey ? `@${task.projectKey} ` : ""}[${task.status}] ${truncate(task.text, 120)}`)
    .join("\n");
}

function formatHelp(): string {
  return [
    "Octomynd Maestro esta online.",
    "",
    "Comandos:",
    "/status - ver estado geral e agentes trabalhando",
    "/status @projeto - ver estado de um projeto",
    "/projects - listar projetos",
    "/project_add chave caminho-do-repo - cadastrar projeto",
    "/task @projeto texto - criar task",
    "/prepare id - criar branch/worktree local",
    "/cancel id - cancelar task ativa ou queued",
    "/queue - listar tasks recentes",
    "/queue @projeto - listar tasks do projeto",
    "/graphs [@projeto] - listar Work Graphs e budgets",
    "/graph_cancel id - cancelar graph parado, preservando evidencias",
    "/features - listar Feature Plans e Feature PRs",
      "/features @projeto - listar Feature Plans e Feature PRs do projeto",
      "/improvements - listar melhorias candidatas",
      "/improve_approve id - aprovar como nova Task + Feature Plan",
      "/improve_reject id - rejeitar sem apagar a auditoria",
      "/doctor [@projeto] - verificar ambiente, providers e acao recomendada",
    "/feature_cancel id [motivo] - cancelar Feature antes do merge, preservando auditoria"
  ].join("\n");
}

export function formatWorkGraphs(
  database: MaestroDatabase,
  graphs: ReturnType<MaestroDatabase["listWorkGraphs"]>,
  projectKey: string | null = null
): string {
  const filtered = graphs.filter((graph) => {
    if (!projectKey) return true;
    const task = database.getTask(database.getGoalRun(graph.runId).taskId);
    return task.projectKey === projectKey;
  });
  if (filtered.length === 0) return "Nenhum Work Graph registrado.";
  return filtered.map((graph) => {
    const task = database.getTask(database.getGoalRun(graph.runId).taskId);
    const artifacts = database.listWorkerArtifacts(graph.id);
    const nodes = graph.nodes.map((node) => (
      `  - ${node.key} [${node.status}] ${node.mode === "writer" ? "WRITE" : "READ"} tentativas ${node.attemptCount}/${node.maxAttempts}`
    ));
    return [
      `Graph #${graph.id} @${task.projectKey ?? "inbox"} task #${task.id} [${graph.status}]`,
      `${graph.objective}`,
      `Readers paralelos: ${graph.maxParallelReaders}; artefatos: ${artifacts.length}`,
      ...nodes,
      ...(["draft", "validated", "waiting_provider"].includes(graph.status)
        ? [`  cancelar: /graph_cancel ${graph.id}`]
        : [])
    ].join("\n");
  }).join("\n\n");
}

export function formatImprovementCandidates(
  candidates: ReturnType<MaestroDatabase["listImprovementProposals"]>
): string {
  if (candidates.length === 0) return "Nenhuma melhoria candidata aguardando decisao.";
  return [
    "Melhorias candidatas:",
    ...candidates.map((item) => (
      `#${item.id} @${item.projectKey ?? "sem-projeto"} [${item.risk}] ${truncate(item.title, 120)}`
    )),
    "",
    "Aprovar cria Task + Feature Plan; nunca aplica mudanca diretamente."
  ].join("\n");
}

export function formatEnvironmentReport(report: EnvironmentDoctorReport): string {
  const failed = report.checks.filter((item) => item.status === "failed");
  return [
    `Environment Doctor @${report.projectKey}: ${report.status}`,
    report.summary,
    `Fingerprint: ${report.fingerprintId}`,
    `Acao: ${report.recommendedAction}`,
    ...(failed.length > 0 ? ["", "Falhas:", ...failed.map((item) => `- ${item.name}: ${item.summary}`)] : [])
  ].join("\n");
}

function formatFeatures(
  database: MaestroDatabase,
  plans: FeaturePlanDetails[],
  features: FeatureRecord[]
): string {
  if (plans.length === 0 && features.length === 0) {
    return "Nenhum Feature Plan ou Feature PR registrado ainda.";
  }

  const planLines = plans.slice(0, 8).flatMap((details) => {
    const { plan, tasks } = details;
    const blockers = tasks.filter((task) => task.taskStatus !== "awaiting_human");
    const eligible = plan.status === "planned" && tasks.length > 0 && blockers.length === 0;
    const integration = database.getFeaturePlanIntegrationDetailsByFeaturePlan(plan.id);
    const lines = [
      `#${plan.id} @${plan.projectKey} [${plan.status}]${plan.status === "planned" ? (eligible ? " elegivel" : " aguardando tasks") : ""} - ${truncate(plan.objective, 160)}`
    ];
    if (blockers.length > 0) {
      lines.push(...blockers.map((task) => `   blocker: task #${task.taskId} (${task.taskStatus})`));
    }
    if (integration) {
      lines.push(
        `   integracao: ${integration.integration.status} (${integration.integration.checkpoint})`
        + (integration.integration.lastError ? ` - ${truncate(integration.integration.lastError, 160)}` : "")
      );
    }
    if (plan.cancelReason) {
      lines.push(`   cancelado: ${truncate(plan.cancelReason, 160)}`);
    }
    return lines;
  });

  const featureLines = features.slice(0, 8).map((feature) => (
    `#${feature.id} @${feature.projectKey} [${feature.status}] - ${feature.pullRequestUrl}`
    + (feature.lastError ? ` - ${truncate(feature.lastError, 160)}` : "")
  ));

  return [
    "Feature Plans:",
    ...(planLines.length > 0 ? planLines : ["- nenhum plano"]),
    "",
    "Feature PRs consolidados (revise apenas estes):",
    ...(featureLines.length > 0 ? featureLines : ["- nenhuma feature ativa"])
  ].join("\n");
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}
