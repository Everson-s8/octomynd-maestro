import { Bot, Context } from "grammy";
import { MaestroConfig } from "../config.js";
import { FeaturePlanDetails, FeatureRecord, MaestroDatabase, ProjectRecord, RuntimeUpdateRecord, TaskRecord } from "../db.js";
import { parseProjectTaskInput } from "../orchestrator.js";
import { ApplicationCommands } from "../commands/application-commands.js";
import type { WorkGraphRuntimeCommands, WorkGraphView } from "../commands/application-commands.js";
import { ApplicationCommandError } from "../commands/errors.js";
import { CommandOrigin } from "../commands/types.js";
import { BacklogAutopilotSnapshot } from "../backlog/autopilot.js";
import { FeatureGitHubGateway, featureChecksPassed } from "../features/github.js";
import type { EnvironmentDoctorReport } from "../environment/types.js";
import type { AgentProviderSnapshot } from "../agents/registry.js";
import type { FeatureCoordinator, ManualReviewResult, ManualReviewStatusResult } from "../features/coordinator.js";
import { OperationalChatService } from "../chat/service.js";
import { formatCurrencyUsd } from "../agents/economics.js";

export type TelegramBotOptions = {
  cancelTask?: (taskId: number) => TaskRecord;
  autopilotStatus?: () => BacklogAutopilotSnapshot | null;
  featureGithub?: FeatureGitHubGateway;
  environmentDoctor?: (projectKey: string) => Promise<EnvironmentDoctorReport>;
  providerStatus?: () => Promise<AgentProviderSnapshot[]>;
  workGraphRuntime?: WorkGraphRuntimeCommands;
  featureCoordinator?: FeatureCoordinator;
  chatService?: OperationalChatService;
  triggerSelfUpdate?: () => Promise<RuntimeUpdateRecord>;
};

export type TelegramSubsystemInfo = {
  id: number;
  username: string;
  first_name: string;
};

export class TelegramSubsystemManager {
  private currentBot: Bot | null = null;
  private isRunning = false;
  private botInfo: TelegramSubsystemInfo | null = null;

  constructor(
    private config: MaestroConfig,
    private database: MaestroDatabase,
    private options: TelegramBotOptions = {}
  ) {}

  public getBotInfo(): TelegramSubsystemInfo | null {
    return this.botInfo;
  }

  public isBotRunning(): boolean {
    return this.isRunning;
  }

  public async start(): Promise<boolean> {
    if (!this.config.telegram.botToken || this.config.telegram.botToken === "dummy_token_for_local_setup") {
      return false;
    }
    try {
      const bot = createTelegramBot(this.config, this.database, this.options);
      const info = await bot.api.getMe();
      this.botInfo = { id: info.id, username: info.username ?? "", first_name: info.first_name };
      this.currentBot = bot;
      this.isRunning = true;
      void bot.start({
        onStart: (botInfo) => {
          console.log(`Telegram bot started as @${botInfo.username}.`);
        }
      });
      return true;
    } catch (error) {
      console.error("Failed to start Telegram bot:", error instanceof Error ? error.message : error);
      this.isRunning = false;
      this.currentBot = null;
      this.botInfo = null;
      return false;
    }
  }

  public async stop(): Promise<void> {
    if (this.currentBot && this.isRunning) {
      try {
        await this.currentBot.stop();
      } catch {
        // Ignore if already stopped
      }
      this.isRunning = false;
      this.currentBot = null;
    }
  }

  public async restart(newToken: string, newAllowedUserId?: string): Promise<{
    success: boolean;
    botInfo?: TelegramSubsystemInfo;
    error?: string;
  }> {
    await this.stop();
    this.config.telegram.botToken = newToken.trim();
    if (newAllowedUserId !== undefined) {
      this.config.telegram.allowedUserId = newAllowedUserId.trim() || null;
    }

    try {
      const started = await this.start();
      if (!started || !this.botInfo) {
        return { success: false, error: "Bot token is valid, but failed to start long-polling runtime." };
      }

      return { success: true, botInfo: this.botInfo };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Invalid bot token or network error: ${errMsg}` };
    }
  }
}

export function createTelegramBot(
  config: MaestroConfig,
  database: MaestroDatabase,
  options: TelegramBotOptions = {}
) {
  const bot = new Bot(config.telegram.botToken);
  const commands = new ApplicationCommands(
    database,
    options.featureGithub,
    options.workGraphRuntime,
    undefined,
    options.featureCoordinator
  );
  const chatService = options.chatService ?? new OperationalChatService({
    database,
    commands
  });

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

  bot.command("cost", async (ctx) => {
    database.addEvent({
      source: "telegram",
      type: "command.cost",
      text: "/cost",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null
    });

    const costSummary = database.getCostSummary();
    await ctx.reply(formatCostSummary(costSummary));
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

  bot.command("update", async (ctx) => {
    database.addEvent({
      source: "telegram",
      type: "command.update",
      text: "/update",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null
    });

    if (!options.triggerSelfUpdate) {
      await ctx.reply("Self-update nao disponivel neste runtime.");
      return;
    }

    try {
      await ctx.reply("Verificando e disparando self-update...");
      const record = await options.triggerSelfUpdate();
      if (record.status === "failed") {
        await ctx.reply(`Self-update falhou: ${record.error}`);
      } else if (record.status === "completed") {
        await ctx.reply(`Runtime ja esta atualizado no commit ${record.targetCommit}.`);
      } else {
        await ctx.reply(`Self-update iniciado. Alvo: ${record.targetCommit.slice(0, 7)}. Reiniciando runtime...`);
      }
    } catch (error) {
      await ctx.reply(`Falha ao disparar self-update: ${error instanceof Error ? error.message : "Erro desconhecido."}`);
    }
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

  bot.command("intake", async (ctx) => {
    const rawText = (ctx.message?.text ?? "").replace(/^\/intake(?:@\w+)?\s*/i, "").trim();
    const taskInput = parseProjectTaskInput(rawText);
    if (!taskInput.text) {
      await ctx.reply("Use: /intake [@projeto] descrever a demanda");
      return;
    }
    try {
      const result = commands.submitWorkIntake(telegramOrigin(ctx), {
        projectKey: taskInput.projectKey,
        objective: taskInput.text
      });
      if (result.status === "needs_clarification") {
        await ctx.reply([
          "Work Intake: Necessita Clarificação.",
          `Explicação: ${result.explanation}`,
          "Por favor, especifique critérios de aceite ou use /task para Tarefa Direta ou /feature para Plano de Funcionalidade."
        ].join("\n"));
        return;
      }
      if (result.createdType === "feature_plan" && result.featurePlan) {
        await ctx.reply([
          `Feature Plan #${result.featurePlan.plan.id} criado.`,
          `Explicação: ${result.explanation}`,
          `Projeto: ${result.featurePlan.plan.projectKey}`,
          `Status: ${result.featurePlan.plan.status}`
        ].join("\n"));
        return;
      }
      if (result.task) {
        await ctx.reply([
          `Task #${result.task.id} criada.`,
          `Explicação: ${result.explanation}`,
          `Projeto: ${result.task.projectKey}`,
          `Estado: ${result.task.status}`
        ].join("\n"));
        return;
      }
      await ctx.reply(`Demanda processada. Explicação: ${result.explanation}`);
    } catch (error) {
      if (error instanceof ApplicationCommandError && error.code === "not_found") {
        await ctx.reply("Nenhum projeto cadastrado. Use /project_add chave caminho-do-repo.");
        return;
      }
      await ctx.reply(["Demanda não criada.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command(["intake_preview", "preview"], async (ctx) => {
    const rawText = (ctx.message?.text ?? "").replace(/^\/(?:intake_preview|preview)(?:@\w+)?\s*/i, "").trim();
    const taskInput = parseProjectTaskInput(rawText);
    if (!taskInput.text) {
      await ctx.reply("Use: /intake_preview [@projeto] descrever a demanda");
      return;
    }
    try {
      const result = commands.previewWorkIntake(telegramOrigin(ctx), {
        projectKey: taskInput.projectKey,
        objective: taskInput.text
      });
      await ctx.reply([
        `Análise de Work Intake:`,
        `Classificação: ${result.decision.classification}`,
        `Confiança: ${Math.round(result.decision.confidence * 100)}%`,
        `Explicação: ${result.explanation}`
      ].join("\n"));
    } catch (error) {
      await ctx.reply(["Preview indisponível.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command("task", async (ctx) => {
    const taskInput = parseProjectTaskInput(parseTaskText(ctx.message?.text ?? ""));
    if (!taskInput.text) {
      await ctx.reply("Use: /task @projeto descrever a demanda");
      return;
    }

    try {
      const result = commands.submitWorkIntake(telegramOrigin(ctx), {
        projectKey: taskInput.projectKey,
        objective: taskInput.text,
        explicitOverride: "direct_task"
      });

      if (result.task) {
        await ctx.reply(
          [
            `Task #${result.task.id} criada.`,
            `Explicação: ${result.explanation}`,
            `Projeto: ${result.task.projectKey}`,
            `Estado: ${result.task.status}`,
            `Demanda: ${result.task.text}`
          ].join("\n")
        );
      } else {
        await ctx.reply(`Resultado: ${result.explanation}`);
      }
    } catch (error) {
      if (error instanceof ApplicationCommandError && error.code === "not_found") {
        await ctx.reply("Nenhum projeto cadastrado. Use /project_add chave caminho-do-repo.");
        return;
      }
      await ctx.reply(["Task nao criada.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command(["feature", "feature_create"], async (ctx) => {
    const rawText = (ctx.message?.text ?? "").replace(/^\/(?:feature|feature_create)(?:@\w+)?\s*/i, "").trim();
    const taskInput = parseProjectTaskInput(rawText);
    if (!taskInput.text) {
      await ctx.reply("Use: /feature [@projeto] descrever o plano de funcionalidade");
      return;
    }

    try {
      const result = commands.submitWorkIntake(telegramOrigin(ctx), {
        objective: taskInput.text,
        projectKey: taskInput.projectKey,
        explicitOverride: "feature_plan"
      });

      if (result.featurePlan) {
        await ctx.reply(
          [
            `Feature Plan #${result.featurePlan.plan.id} criado.`,
            `Explicação: ${result.explanation}`,
            `Projeto: ${result.featurePlan.plan.projectKey}`,
            `Status: ${result.featurePlan.plan.status}`
          ].join("\n")
        );
      } else {
        await ctx.reply(`Resultado: ${result.explanation}`);
      }
    } catch (error) {
      if (error instanceof ApplicationCommandError && error.code === "not_found") {
        await ctx.reply("Nenhum projeto cadastrado. Use /project_add chave caminho-do-repo.");
        return;
      }
      await ctx.reply(["Feature Plan não criado.", ...commandErrorDetails(error)].join("\n"));
    }
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
    await ctx.reply(formatWorkGraphs(commands.listWorkGraphs(10), projectKey));
  });

  bot.command("graph_cancel", async (ctx) => {
    const graphId = parseTaskId(ctx.message?.text ?? "", "graph_cancel");
    if (!graphId) {
      await ctx.reply("Use: /graph_cancel id");
      return;
    }
    try {
      const graph = await commands.cancelWorkGraph(telegramOrigin(ctx), graphId, "Cancelado pelo Telegram.");
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

  bot.command("feature_pause", async (ctx) => {
    const parsed = parseFeaturePauseText(ctx.message?.text ?? "");
    if (!parsed) {
      await ctx.reply("Use: /feature_pause id [motivo]");
      return;
    }
    database.addEvent({
      source: "telegram",
      type: "command.feature_pause",
      text: ctx.message?.text ?? "/feature_pause",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null,
      metadata: parsed
    });
    try {
      const result = commands.pauseFeaturePlan(telegramOrigin(ctx), parsed.planId, parsed.reason);
      await ctx.reply(
        [
          `Feature Plan #${result.plan.id} pausado.`,
          `Motivo: ${result.plan.pauseReason || "Sem motivo informado."}`,
          `Proxima acao: Use /feature_resume ${result.plan.id} para retomar.`
        ].join("\n")
      );
    } catch (error) {
      await ctx.reply(["Pausa nao executada.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command("feature_resume", async (ctx) => {
    const planId = parseTaskId(ctx.message?.text ?? "", "feature_resume");
    if (!planId) {
      await ctx.reply("Use: /feature_resume id");
      return;
    }
    database.addEvent({
      source: "telegram",
      type: "command.feature_resume",
      text: ctx.message?.text ?? "/feature_resume",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null,
      metadata: { planId }
    });
    try {
      const result = commands.resumeFeaturePlan(telegramOrigin(ctx), planId);
      await ctx.reply(
        [
          `Feature Plan #${result.plan.id} retomado.`,
          "Proxima acao: O plano voltou para a fila governada."
        ].join("\n")
      );
    } catch (error) {
      await ctx.reply(["Retomada nao executada.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command("feature_priority", async (ctx) => {
    const parsed = parseFeaturePriorityText(ctx.message?.text ?? "");
    if (!parsed) {
      await ctx.reply("Use: /feature_priority id prioridade");
      return;
    }
    database.addEvent({
      source: "telegram",
      type: "command.feature_priority",
      text: ctx.message?.text ?? "/feature_priority",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null,
      metadata: parsed
    });
    try {
      const result = commands.updateFeaturePlanPriority(telegramOrigin(ctx), parsed.planId, parsed.priority);
      await ctx.reply(`Feature Plan #${result.plan.id} prioridade atualizada para ${result.plan.priority}.`);
    } catch (error) {
      await ctx.reply(["Atualizacao de prioridade nao executada.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command("feature_retry", async (ctx) => {
    const parsed = parseFeatureRetryText(ctx.message?.text ?? "");
    if (!parsed) {
      await ctx.reply("Use: /feature_retry id [motivo]");
      return;
    }
    database.addEvent({
      source: "telegram",
      type: "command.feature_retry",
      text: ctx.message?.text ?? "/feature_retry",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null,
      metadata: parsed
    });
    try {
      const result = commands.retryFeaturePlan(telegramOrigin(ctx), parsed.planId, parsed.reason);
      await ctx.reply(
        [
          `Feature Plan #${result.plan.id} enviado para tentativa novamente (blocked -> queued).`,
          "Proxima acao: A fila revalidou a elegibilidade."
        ].join("\n")
      );
    } catch (error) {
      await ctx.reply(["Tentativa de retry nao executada.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command("feature_plan_cancel", async (ctx) => {
    const parsed = parseFeaturePlanCancelText(ctx.message?.text ?? "");
    if (!parsed) {
      await ctx.reply("Use: /feature_plan_cancel id [motivo]");
      return;
    }
    database.addEvent({
      source: "telegram",
      type: "command.feature_plan_cancel",
      text: ctx.message?.text ?? "/feature_plan_cancel",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null,
      metadata: parsed
    });
    try {
      const result = commands.cancelFeaturePlan(telegramOrigin(ctx), parsed.planId, parsed.reason);
      await ctx.reply(
        [
          `Feature Plan #${result.plan.id} cancelado.`,
          `Estado: ${result.plan.status}`,
          `Motivo: ${result.plan.cancelReason || "Sem motivo"}`
        ].join("\n")
      );
    } catch (error) {
      await ctx.reply(["Cancelamento do plano nao executado.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command("review", async (ctx) => {
    const target = parseReviewTargetText(ctx.message?.text ?? "", "review");
    if (!target) {
      await ctx.reply("Use: /review <id-ou-url-pr>");
      return;
    }
    database.addEvent({
      source: "telegram",
      type: "command.review",
      text: ctx.message?.text ?? "/review",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null,
      metadata: { target }
    });

    try {
      const result = await commands.triggerFeatureReview(telegramOrigin(ctx), target, false);
      await ctx.reply(formatManualReviewMessage(result));
    } catch (error) {
      await ctx.reply(["Revisao nao executada.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command("review_status", async (ctx) => {
    const target = parseReviewTargetText(ctx.message?.text ?? "", "review_status");
    if (!target) {
      await ctx.reply("Use: /review_status <id-ou-url-pr>");
      return;
    }
    database.addEvent({
      source: "telegram",
      type: "command.review_status",
      text: ctx.message?.text ?? "/review_status",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null,
      metadata: { target }
    });

    try {
      const statusResult = await commands.getFeatureReviewStatus(telegramOrigin(ctx), target);
      await ctx.reply(formatManualReviewStatusMessage(statusResult));
    } catch (error) {
      await ctx.reply(["Consulta de revisao nao realizada.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command("review_retry", async (ctx) => {
    const target = parseReviewTargetText(ctx.message?.text ?? "", "review_retry");
    if (!target) {
      await ctx.reply("Use: /review_retry <id-ou-url-pr>");
      return;
    }
    database.addEvent({
      source: "telegram",
      type: "command.review_retry",
      text: ctx.message?.text ?? "/review_retry",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null,
      metadata: { target }
    });

    try {
      const result = await commands.triggerFeatureReview(telegramOrigin(ctx), target, true);
      await ctx.reply(formatManualReviewMessage(result));
    } catch (error) {
      await ctx.reply(["Nova tentativa de revisao nao executada.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command("chat", async (ctx) => {
    const { projectKey: inputProjectKey, message } = parseChatText(ctx.message?.text ?? "");
    if (!message) {
      await ctx.reply("Use: /chat [@projeto] sua mensagem aqui");
      return;
    }

    if (!inputProjectKey) {
      await ctx.reply("Por favor, informe o projeto: /chat @projeto sua mensagem");
      return;
    }

    if (!database.findProjectByKey(inputProjectKey)) {
      await ctx.reply(`Projeto @${inputProjectKey} nao encontrado.`);
      return;
    }

    database.addEvent({
      source: "telegram",
      type: "command.chat",
      text: ctx.message?.text ?? "/chat",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null,
      metadata: { projectKey: inputProjectKey, message }
    });

    try {
      const response = await chatService.ask({
        projectKey: inputProjectKey,
        surface: "telegram",
        message,
        userId: String(ctx.from?.id ?? ""),
        username: ctx.from?.username ?? null
      });

      const replyLines = [response.explanation];
      if (response.actions.length > 0) {
        replyLines.push("");
        replyLines.push("Acoes governadas disponiveis:");
        for (const action of response.actions) {
          replyLines.push(`- /chat_action @${inputProjectKey} ${action.id} (${action.label})`);
        }
      }
      await ctx.reply(replyLines.join("\n"));
    } catch (error) {
      await ctx.reply(`Erro no chat operacional: ${error instanceof Error ? error.message : "Erro desconhecido."}`);
    }
  });

  bot.command("chat_action", async (ctx) => {
    const { projectKey, actionId, confirmed } = parseChatActionText(ctx.message?.text ?? "");
    if (!projectKey || !actionId) {
      await ctx.reply("Use: /chat_action @projeto <action_id>");
      return;
    }

    if (!database.findProjectByKey(projectKey)) {
      await ctx.reply(`Projeto @${projectKey} nao encontrado.`);
      return;
    }

    const evidence = await chatService.gatherEvidenceContext(projectKey);
    const actions = chatService.identifyGovernedActions(evidence);
    const action = actions.find((a) => a.id === actionId);

    if (!action) {
      await ctx.reply(`Acao '${actionId}' nao encontrada ou nao aplicavel para @${projectKey}.`);
      return;
    }

    if (chatService.isHighImpactAction(action)) {
      if (!confirmed) {
        await ctx.reply(`Acao de alto impacto: ${action.label}.\nPara confirmar pelo Telegram, use: /chat_action @${projectKey} ${actionId} confirm`);
        return;
      }
    }

    try {
      const result = await chatService.executeAction({
        projectKey,
        surface: "telegram",
        action,
        userId: String(ctx.from?.id ?? ""),
        username: ctx.from?.username ?? null
      });
      await ctx.reply(result.resultSummary);
    } catch (error) {
      await ctx.reply(`Falha ao executar acao governada: ${error instanceof Error ? error.message : "Erro desconhecido."}`);
    }
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

    await ctx.reply("Feedback recebido e registrado. Use /chat @projeto mensagem para conversar com o orquestrador.");
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

export function parseChatText(messageText: string): { projectKey: string | null; message: string } {
  const text = messageText.replace(/^\/chat(?:@\w+)?\s*/i, "").trim();
  const match = text.match(/^@([a-z0-9][a-z0-9_-]{1,48})\s+(.+)$/s);
  if (match) {
    return { projectKey: match[1].toLowerCase(), message: match[2].trim() };
  }
  return { projectKey: null, message: text };
}

export function parseChatActionText(messageText: string): { projectKey: string | null; actionId: string | null; confirmed: boolean } {
  const text = messageText.replace(/^\/chat_action(?:@\w+)?\s*/i, "").trim();
  const match = text.match(/^@([a-z0-9][a-z0-9_-]{1,48})\s+(\S+)(?:\s+(confirm|yes))?$/i);
  return match
    ? { projectKey: match[1].toLowerCase(), actionId: match[2], confirmed: Boolean(match[3]) }
    : { projectKey: null, actionId: null, confirmed: false };
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

export function parseFeaturePriorityText(
  messageText: string
): { planId: number; priority: number } | null {
  const match = messageText.match(/^\/feature_priority(?:@\w+)?\s+(\d+)\s+(\d+)\s*$/i);
  if (!match) return null;
  return { planId: Number(match[1]), priority: Number(match[2]) };
}

export function parseFeaturePauseText(
  messageText: string
): { planId: number; reason: string | null } | null {
  const match = messageText.match(/^\/feature_pause(?:@\w+)?\s+(\d+)(?:\s+(.+))?\s*$/i);
  if (!match) return null;
  return { planId: Number(match[1]), reason: match[2]?.trim() || null };
}

export function parseFeatureRetryText(
  messageText: string
): { planId: number; reason: string | null } | null {
  const match = messageText.match(/^\/feature_retry(?:@\w+)?\s+(\d+)(?:\s+(.+))?\s*$/i);
  if (!match) return null;
  return { planId: Number(match[1]), reason: match[2]?.trim() || null };
}

export function parseFeaturePlanCancelText(
  messageText: string
): { planId: number; reason: string | null } | null {
  const match = messageText.match(/^\/feature_plan_cancel(?:@\w+)?\s+(\d+)(?:\s+(.+))?\s*$/i);
  if (!match) return null;
  return { planId: Number(match[1]), reason: match[2]?.trim() || null };
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

function formatCostSummary(summary: ReturnType<MaestroDatabase["getCostSummary"]>): string {
  const totalTokens = summary.todayInputTokens + summary.todayOutputTokens;
  const lines: string[] = [
    "💰 Provider Economics & Cost Summary",
    "",
    `Custo Hoje: ${formatCurrencyUsd(summary.todayTotalUsd, { decimals: 4 })} USD`,
    `Tokens Hoje: ${totalTokens.toLocaleString()} (${summary.todayInputTokens.toLocaleString()} in / ${summary.todayOutputTokens.toLocaleString()} out)`
  ];

  if (summary.byProvider.length > 0) {
    lines.push("", "Por Provider:");
    for (const p of summary.byProvider) {
      const pTokens = p.inputTokens + p.outputTokens;
      lines.push(`• ${p.provider}: ${formatCurrencyUsd(p.costUsd, { decimals: 4 })} (${pTokens.toLocaleString()} tokens)`);
    }
  }

  if (summary.byProject.length > 0) {
    lines.push("", "Por Projeto:");
    for (const proj of summary.byProject) {
      const projTokens = proj.inputTokens + proj.outputTokens;
      lines.push(`• @${proj.projectKey}: ${formatCurrencyUsd(proj.costUsd, { decimals: 4 })} (${projTokens.toLocaleString()} tokens)`);
    }
  }

  return lines.join("\n");
}

function formatHelp(): string {
  return [
    "Octomynd Maestro esta online.",
    "",
    "Comandos:",
    "/status - ver estado geral e agentes trabalhando",
    "/status @projeto - ver estado de um projeto",
    "/cost - ver consumo de tokens e custos estimados por provider e projeto",
    "/projects - listar projetos",
    "/project_add chave caminho-do-repo - cadastrar projeto",
    "/intake @projeto texto - classificar e submeter demanda",
    "/intake_preview @projeto texto - analisar classificacao de demanda",
    "/task @projeto texto - criar task",
    "/prepare id - criar branch/worktree local",
    "/cancel id - cancelar task ativa ou queued",
    "/queue - listar tasks recentes",
    "/queue @projeto - listar tasks do projeto",
    "/graphs [@projeto] - listar Work Graphs e budgets",
    "/graph_cancel id - cancelar graph ativo ou parado, preservando evidencias",
    "/features - listar Feature Plans e Feature PRs",
    "/features @projeto - listar Feature Plans e Feature PRs do projeto",
    "/feature_priority id prio - alterar prioridade do Feature Plan",
    "/feature_pause id [motivo] - pausar Feature Plan na fila",
    "/feature_resume id - retomar Feature Plan pausado",
    "/feature_retry id [motivo] - tentar novamente Feature Plan bloqueado",
    "/feature_plan_cancel id [motivo] - cancelar Feature Plan",
    "/improvements - listar melhorias candidatas",
    "/improve_approve id - aprovar como nova Task + Feature Plan",
    "/improve_reject id - rejeitar sem apagar a auditoria",
    "/doctor [@projeto] - verificar ambiente, providers e acao recomendada",
    "/feature_cancel id [motivo] - cancelar Feature PR consolidado antes do merge",
    "/review id-ou-url - solicitar revisao final manual de Feature PR",
    "/review_status id-ou-url - verificar estado da revisao final de Feature PR",
    "/review_retry id-ou-url - tentar novamente a revisao final de Feature PR",
    "/update - verificar e disparar self-update manual"
  ].join("\n");
}

export function parseReviewTargetText(messageText: string, commandName: string): string | null {
  const regex = new RegExp(`^\\/${commandName}(?:@\\w+)?\\s*(.*)$`, "i");
  const match = messageText.trim().match(regex);
  if (!match || !match[1]?.trim()) {
    return null;
  }
  return match[1].trim();
}

export function formatManualReviewMessage(result: ManualReviewResult): string {
  const lines: string[] = [];
  if (result.success && result.status === "completed") {
    lines.push(
      `Revisao final aprovada para Feature #${result.feature.id}!`,
      `Projeto: @${result.feature.projectKey}`,
      `PR: ${result.feature.pullRequestUrl}`,
      `Revisor: ${result.providerId ?? result.feature.reviewerProvider ?? "provider configurado"}`,
      "Status: Feature PR mesclado com sucesso."
    );
  } else if (result.status === "changes_requested") {
    lines.push(
      `Revisao final solicitou ajustes para Feature #${result.feature.id}.`,
      `Projeto: @${result.feature.projectKey}`,
      `PR: ${result.feature.pullRequestUrl}`,
      `Revisor: ${result.providerId ?? result.feature.reviewerProvider ?? "provider configurado"}`,
      `Ajustes: ${result.summary || result.message}`,
      "O PR retornou para draft para correcoes."
    );
  } else {
    lines.push(
      `Revisao final nao executada para Feature #${result.feature.id}.`,
      `Projeto: @${result.feature.projectKey}`,
      `PR: ${result.feature.pullRequestUrl}`,
      `Status: ${result.status}`,
      `Motivo: ${result.message}`
    );
  }
  return lines.join("\n");
}

export function formatManualReviewStatusMessage(result: ManualReviewStatusResult): string {
  const { feature, prState, isReady, notReadyReason, isReviewActive } = result;
  const checksPassed = featureChecksPassed(prState);
  const lines: string[] = [
    `Status da revisao final - Feature #${feature.id}`,
    `Projeto: @${feature.projectKey}`,
    `PR: ${feature.pullRequestUrl}`,
    `Estado no Maestro: ${feature.status}${isReviewActive ? " (em andamento)" : ""}`,
    `Estado no GitHub: ${prState.state} | ${prState.isDraft ? "Draft" : "Ready"} | ${prState.mergeable}`,
    `Checks obrigatorios: ${prState.checks.length > 0 ? (checksPassed ? "passaram" : "pendentes/falharam") : "sem checks"}`,
    `Revisor: ${feature.reviewerProvider ?? "Nenhum"}`
  ];

  if (feature.reviewSummary) {
    lines.push(`Ultimo resultado: ${truncate(feature.reviewSummary, 200)}`);
  } else if (feature.lastError) {
    lines.push(`Ultimo erro: ${truncate(feature.lastError, 200)}`);
  }

  lines.push(`Pronto para revisao: ${isReady ? "Sim" : `Nao (${notReadyReason ?? "alvo nao elegivel"})`}`);

  return lines.join("\n");
}

export function formatWorkGraphs(
  graphs: WorkGraphView[],
  projectKey: string | null = null
): string {
  const filtered = graphs.filter((graph) => !projectKey || graph.projectKey === projectKey);
  if (filtered.length === 0) return "Nenhum Work Graph registrado.";
  return filtered.map((graph) => {
    const nodes = graph.nodes.flatMap((node) => {
      const attempts = node.attempts.map((attempt) => (
        `      #${attempt.attemptNumber} ${attempt.provider} [${attempt.status}] ${formatDuration(attempt.durationMs)}`
      ));
      return [
        `  - ${node.key} [${node.status}] ${node.mode === "writer" ? "WRITE" : "READ"} tentativas ${node.attemptCount}/${node.maxAttempts}${node.fallbackCount ? `; fallbacks ${node.fallbackCount}` : ""}`,
        ...attempts
      ];
    });
    const adoption = graph.adoption
      ? `Adocao: ${graph.adoption.decision}/${graph.adoption.executionMode} (${graph.adoption.reason})`
      : "Adocao: sem evento persistido";
    return [
      `Graph #${graph.id} @${graph.projectKey ?? "inbox"} task #${graph.taskId} [${graph.status}]`,
      `${graph.objective}`,
      adoption,
      `Readers paralelos: ${graph.maxParallelReaders}; artefatos: ${graph.artifactCount}`,
      `Canario: ${graph.canary.quality}; ${formatDuration(graph.canary.durationMs)}; attempts ${graph.canary.attempts}; fallbacks ${graph.canary.fallbacks}; conflitos ${graph.canary.conflicts}; tokens~${graph.canary.estimatedTokens}`,
      ...nodes,
      ...graph.artifacts.slice(0, 4).map((artifact) => `  artifact: ${artifact.key} (${artifact.kind}, ${artifact.bytes} bytes)`),
      ...(graph.cancellable
        ? [`  cancelar: /graph_cancel ${graph.id}`]
        : [])
    ].join("\n");
  }).join("\n\n");
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "em andamento";
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
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
    const eligible = plan.status === "queued" && tasks.length > 0 && blockers.length === 0;
    const integration = database.getFeaturePlanIntegrationDetailsByFeaturePlan(plan.id);
    const nextAction = plan.status === "blocked"
      ? `Resolva a causa do bloqueio e execute /feature_retry ${plan.id}`
      : plan.isPaused
      ? `Execute /feature_resume ${plan.id} para retomar`
      : plan.status === "queued" && eligible
      ? "Plano elegivel para admissao/inicio"
      : plan.status === "queued"
      ? "Aguardando dependencias ou liberacao do projeto"
      : "Tasks em andamento pelo agente";

    const lines = [
      `#${plan.id} @${plan.projectKey} [${plan.status}] prio:${plan.priority ?? 0}${plan.isPaused ? " [PAUSADO]" : ""}${plan.status === "queued" ? (eligible ? " (elegivel)" : " (aguardando)") : ""} - ${truncate(plan.objective, 140)}`
    ];
    if (plan.pauseReason) {
      lines.push(`   motivo pausa: ${truncate(plan.pauseReason, 140)}`);
    }
    if (plan.blockedReason) {
      lines.push(`   bloqueio: ${truncate(plan.blockedReason, 140)}`);
    }
    if (blockers.length > 0) {
      lines.push(...blockers.map((task) => `   blocker: task #${task.taskId} (${task.taskStatus})`));
    }
    lines.push(`   proxima acao: ${nextAction}`);
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
