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
import { ProjectRepositoryService } from "../projects/repository-service.js";
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
  repositoryService?: ProjectRepositoryService;
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
  // grammy throws on an empty token. The desktop app constructs the runtime
  // before Telegram is configured, so fall back to the inert placeholder the
  // subsystem manager already treats as "do not start long-polling".
  const bot = new Bot(config.telegram.botToken || "dummy_token_for_local_setup");
  const commands = new ApplicationCommands(
    database,
    options.featureGithub,
    options.workGraphRuntime,
    undefined,
    options.featureCoordinator,
    undefined,
    options.repositoryService
  );
  const chatService = options.chatService ?? new OperationalChatService({
    database,
    commands,
    repositoryService: options.repositoryService
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

    await ctx.reply("Unauthorized access to this Maestro instance.");
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
      await ctx.reply(`Project @${projectKey} not found.`);
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
      await ctx.reply("Environment Doctor is unavailable.");
      return;
    }
    const requestedKey = parseDoctorProjectKey(ctx.message?.text ?? "");
    const project = requestedKey ? database.findProjectByKey(requestedKey) : database.getDefaultProject();
    if (!project) {
      await ctx.reply(requestedKey ? `Project @${requestedKey} not found.` : "No projects registered.");
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
      await ctx.reply("Self-update is unavailable in this runtime.");
      return;
    }

    try {
      await ctx.reply("Verificando e disparando self-update...");
      const record = await options.triggerSelfUpdate();
      if (record.status === "failed") {
        await ctx.reply(`Self-update failed: ${record.error}`);
      } else if (record.status === "completed") {
        await ctx.reply(`Runtime is already up to date at commit ${record.targetCommit}.`);
      } else {
        await ctx.reply(`Self-update started. Target: ${record.targetCommit.slice(0, 7)}. Restarting runtime...`);
      }
    } catch (error) {
      await ctx.reply(`Failed to start self-update: ${error instanceof Error ? error.message : "Unknown error."}`);
    }
  });

  bot.command("project_add", async (ctx) => {
    const input = parseProjectAddText(ctx.message?.text ?? "");
    if (!input) {
      await ctx.reply("Usage: /project_add key repository-path");
      return;
    }

    let result;
    try {
      result = commands.registerProject(telegramOrigin(ctx), input);
    } catch (error) {
      await ctx.reply(["Project is not registered.", ...commandErrorDetails(error)].join("\n"));
      return;
    }

    const lines = [
      `Project ${result.project.key} registered.`,
      `Name: ${result.project.name}`,
      `Default branch: ${result.project.defaultBranch}`
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
      await ctx.reply("Usage: /intake [@project] describe the request");
      return;
    }
    try {
      const result = commands.submitWorkIntake(telegramOrigin(ctx), {
        projectKey: taskInput.projectKey,
        objective: taskInput.text
      });
      if (result.status === "needs_clarification") {
        await ctx.reply([
          "Work Intake: Needs clarification.",
          `Explanation: ${result.explanation}`,
          "Please specify acceptance criteria or use /task for a Direct Task or /feature for a Feature Plan."
        ].join("\n"));
        return;
      }
      if (result.createdType === "feature_plan" && result.featurePlan) {
        await ctx.reply([
          `Feature Plan #${result.featurePlan.plan.id} created.`,
          `Explanation: ${result.explanation}`,
          `Project: ${result.featurePlan.plan.projectKey}`,
          `Status: ${result.featurePlan.plan.status}`
        ].join("\n"));
        return;
      }
      if (result.task) {
        await ctx.reply([
          `Task #${result.task.id} created.`,
          `Explanation: ${result.explanation}`,
          `Project: ${result.task.projectKey}`,
          `Status: ${result.task.status}`
        ].join("\n"));
        return;
      }
      await ctx.reply(`Request processed. Explanation: ${result.explanation}`);
    } catch (error) {
      if (error instanceof ApplicationCommandError && error.code === "not_found") {
        await ctx.reply("No projects registered. Use /project_add key repository-path.");
        return;
      }
      await ctx.reply(["Request was not created.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command(["intake_preview", "preview"], async (ctx) => {
    const rawText = (ctx.message?.text ?? "").replace(/^\/(?:intake_preview|preview)(?:@\w+)?\s*/i, "").trim();
    const taskInput = parseProjectTaskInput(rawText);
    if (!taskInput.text) {
      await ctx.reply("Usage: /intake_preview [@project] describe the request");
      return;
    }
    try {
      const result = commands.previewWorkIntake(telegramOrigin(ctx), {
        projectKey: taskInput.projectKey,
        objective: taskInput.text
      });
      await ctx.reply([
        `Work Intake analysis:`,
        `Classification: ${result.decision.classification}`,
        `Confidence: ${Math.round(result.decision.confidence * 100)}%`,
        `Explanation: ${result.explanation}`
      ].join("\n"));
    } catch (error) {
      await ctx.reply(["Preview unavailable.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command("task", async (ctx) => {
    const taskInput = parseProjectTaskInput(parseTaskText(ctx.message?.text ?? ""));
    if (!taskInput.text) {
      await ctx.reply("Usage: /task @project describe the request");
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
            `Task #${result.task.id} created.`,
            `Explanation: ${result.explanation}`,
            `Project: ${result.task.projectKey}`,
            `Status: ${result.task.status}`,
            `Request: ${result.task.text}`
          ].join("\n")
        );
      } else {
        await ctx.reply(`Resultado: ${result.explanation}`);
      }
    } catch (error) {
      if (error instanceof ApplicationCommandError && error.code === "not_found") {
        await ctx.reply("No projects registered. Use /project_add key repository-path.");
        return;
      }
      await ctx.reply(["Task was not created.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command("followup", async (ctx) => {
    const raw = (ctx.message?.text ?? "").replace(/^\/followup(?:@\w+)?\s*/i, "").trim();
    const match = /^(\d+)\s+([\s\S]+)$/.exec(raw);
    if (!match) {
      await ctx.reply("Usage: /followup task-id describe the change or improvement");
      return;
    }
    try {
      const task = commands.createFollowUpTask(telegramOrigin(ctx), {
        parentTaskId: Number(match[1]),
        text: match[2].trim()
      });
      await ctx.reply([
        `Task #${task.id} created as a follow-up to Task #${match[1]}.`,
        `Project: ${task.projectKey}`,
        `Status: ${task.status}`,
        `Request: ${task.text}`
      ].join("\n"));
    } catch (error) {
      await ctx.reply(["Follow-up task was not created.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command(["feature", "feature_create"], async (ctx) => {
    const rawText = (ctx.message?.text ?? "").replace(/^\/(?:feature|feature_create)(?:@\w+)?\s*/i, "").trim();
    const taskInput = parseProjectTaskInput(rawText);
    if (!taskInput.text) {
      await ctx.reply("Usage: /feature [@project] describe the feature plan");
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
            `Feature Plan #${result.featurePlan.plan.id} created.`,
            `Explanation: ${result.explanation}`,
            `Project: ${result.featurePlan.plan.projectKey}`,
            `Status: ${result.featurePlan.plan.status}`
          ].join("\n")
        );
      } else {
        await ctx.reply(`Resultado: ${result.explanation}`);
      }
    } catch (error) {
      if (error instanceof ApplicationCommandError && error.code === "not_found") {
        await ctx.reply("No projects registered. Use /project_add key repository-path.");
        return;
      }
        await ctx.reply(["Feature Plan was not created.", ...commandErrorDetails(error)].join("\n"));
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
      await ctx.reply(`Project @${projectKey} not found.`);
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
      await ctx.reply("Usage: /graph_cancel id");
      return;
    }
    try {
      const graph = await commands.cancelWorkGraph(telegramOrigin(ctx), graphId, "Cancelled through Telegram.");
      await ctx.reply(`Work Graph #${graph.id} cancelled. Artifacts and history were preserved.`);
    } catch (error) {
      await ctx.reply(["Work Graph cancellation was not applied.", ...commandErrorDetails(error)].join("\n"));
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
      await ctx.reply(["Preparation failed.", ...commandErrorDetails(error)].join("\n"));
      return;
    }

    await ctx.reply(
      [
        `Task #${result.task.id} prepared.`,
        `Status: ${result.task.status}`,
        `Branch: ${result.branchName}`,
        "Isolated worktree prepared."
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
        `Improvement #${result.improvement.id} approved without direct mutation.`,
        `Task created: #${result.task?.id}`,
        `Feature Plan created: #${result.featurePlan?.plan.id}`,
        "The normal backlog will take over implementation and the consolidated PR will remain the final gate."
      ].join("\n"));
    } catch (error) {
      await ctx.reply(["Approval was not applied.", ...commandErrorDetails(error)].join("\n"));
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
      await ctx.reply(`Improvement #${result.improvement.id} rejected and preserved for audit.`);
    } catch (error) {
      await ctx.reply(["Rejection was not applied.", ...commandErrorDetails(error)].join("\n"));
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
      await ctx.reply(`Project @${projectKey} not found.`);
      return;
    }

    const plans = commands.listFeaturePlans(projectKey, 10);
    const features = database.listFeatures(30).filter((feature) => !projectKey || feature.projectKey === projectKey);
    await ctx.reply(formatFeatures(database, plans, features));
  });

  bot.command("feature_cancel", async (ctx) => {
    const parsed = parseFeatureCancelText(ctx.message?.text ?? "");
    if (!parsed) {
      await ctx.reply("Usage: /feature_cancel id [reason]");
      return;
    }

    let feature: FeatureRecord;
    try {
      feature = await commands.cancelFeature(telegramOrigin(ctx), parsed.featureId, parsed.reason);
    } catch (error) {
      await ctx.reply(["Cancellation was not applied.", ...commandErrorDetails(error)].join("\n"));
      return;
    }

    await ctx.reply(
      [
        `Feature #${feature.id} cancelled.`,
        `Status: ${feature.status}`,
        "The consolidated PR and history remain available for audit.",
        `PR: ${feature.pullRequestUrl}`
      ].join("\n")
    );
  });

  bot.command("feature_pause", async (ctx) => {
    const parsed = parseFeaturePauseText(ctx.message?.text ?? "");
    if (!parsed) {
      await ctx.reply("Usage: /feature_pause id [reason]");
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
          `Feature Plan #${result.plan.id} paused.`,
          `Reason: ${result.plan.pauseReason || "No reason provided."}`,
          `Next action: use /feature_resume ${result.plan.id} to resume.`
        ].join("\n")
      );
    } catch (error) {
      await ctx.reply(["Pause was not executed.", ...commandErrorDetails(error)].join("\n"));
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
          `Feature Plan #${result.plan.id} resumed.`,
          "Next action: the plan returned to the governed queue."
        ].join("\n")
      );
    } catch (error) {
      await ctx.reply(["Resume was not executed.", ...commandErrorDetails(error)].join("\n"));
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
      await ctx.reply(`Feature Plan #${result.plan.id} priority updated to ${result.plan.priority}.`);
    } catch (error) {
      await ctx.reply(["Priority update was not executed.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command("feature_retry", async (ctx) => {
    const parsed = parseFeatureRetryText(ctx.message?.text ?? "");
    if (!parsed) {
      await ctx.reply("Usage: /feature_retry id [reason]");
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
          `Feature Plan #${result.plan.id} queued for another attempt (blocked -> queued).`,
          "Next action: the queue revalidated eligibility."
        ].join("\n")
      );
    } catch (error) {
      await ctx.reply(["Retry was not executed.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command("feature_plan_cancel", async (ctx) => {
    const parsed = parseFeaturePlanCancelText(ctx.message?.text ?? "");
    if (!parsed) {
      await ctx.reply("Usage: /feature_plan_cancel id [reason]");
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
          `Feature Plan #${result.plan.id} cancelled.`,
          `Status: ${result.plan.status}`,
          `Reason: ${result.plan.cancelReason || "No reason"}`
        ].join("\n")
      );
    } catch (error) {
      await ctx.reply(["Plan cancellation was not executed.", ...commandErrorDetails(error)].join("\n"));
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
      await ctx.reply(["Review was not executed.", ...commandErrorDetails(error)].join("\n"));
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
      await ctx.reply(["Review status was not retrieved.", ...commandErrorDetails(error)].join("\n"));
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
      await ctx.reply(["Review retry was not executed.", ...commandErrorDetails(error)].join("\n"));
    }
  });

  bot.command("chat", async (ctx) => {
    const { projectKey: inputProjectKey, message } = parseChatText(ctx.message?.text ?? "");
    if (!message) {
      await ctx.reply("Usage: /chat [@project] your message here");
      return;
    }

    if (!inputProjectKey) {
      await ctx.reply("Please provide the project: /chat @project your message");
      return;
    }

    if (!database.findProjectByKey(inputProjectKey)) {
      await ctx.reply(`Project @${inputProjectKey} not found.`);
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
        replyLines.push("Available governed actions:");
        for (const action of response.actions) {
          replyLines.push(`- /chat_action @${inputProjectKey} ${action.id} (${action.label})`);
        }
      }
      await ctx.reply(replyLines.join("\n"));
    } catch (error) {
      await ctx.reply(`Operational chat error: ${error instanceof Error ? error.message : "Unknown error."}`);
    }
  });

  bot.command("chat_action", async (ctx) => {
    const { projectKey, actionId, confirmed } = parseChatActionText(ctx.message?.text ?? "");
    if (!projectKey || !actionId) {
      await ctx.reply("Usage: /chat_action @project <action_id>");
      return;
    }

    if (!database.findProjectByKey(projectKey)) {
      await ctx.reply(`Project @${projectKey} not found.`);
      return;
    }

    const evidence = await chatService.gatherEvidenceContext(projectKey);
    const actions = chatService.identifyGovernedActions(evidence);
    const action = actions.find((a) => a.id === actionId);

    if (!action) {
      await ctx.reply(`Action '${actionId}' was not found or is not applicable to @${projectKey}.`);
      return;
    }

    if (chatService.isHighImpactAction(action)) {
      if (!confirmed) {
        await ctx.reply(`High-impact action: ${action.label}.\nTo confirm through Telegram, use: /chat_action @${projectKey} ${actionId} confirm`);
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
      await ctx.reply(`Governed action failed: ${error instanceof Error ? error.message : "Unknown error."}`);
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
      await ctx.reply("Unknown command. Use /help.");
      return;
    }

    database.addEvent({
      source: "telegram",
      type: "feedback.received",
      text,
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null
    });

    await ctx.reply("Feedback received and recorded. Use /chat @project message to talk with the orchestrator.");
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
  if (!cancelTask) return "Cancellation is unavailable in this runtime.";
  try {
    const task = cancelTask(taskId);
    return `Task #${task.id} cancelled. Status: ${task.status}.`;
  } catch (error) {
    return error instanceof Error ? error.message : "Unable to cancel the task.";
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
    const provider = database.listGoalSteps(goal.id).at(-1)?.provider ?? "routing agent";
    return `- #${task.id} @${task.projectKey ?? "inbox"}: ${provider} in ${goal.currentPhase} (${goal.stepCount}/${goal.maxSteps})`;
  });
  const activeGraphs = database.listWorkGraphs(30).filter((graph) => {
    if (!["draft", "validated", "running", "waiting_provider"].includes(graph.status)) return false;
    if (!projectKey) return true;
    const task = database.getTask(database.getGoalRun(graph.runId).taskId);
    return task.projectKey === projectKey;
  });

  return [
    `Maestro: online`,
    projectKey ? `Project: @${projectKey}` : `Workspace: ${projectName}`,
    `Projects: ${projects.length}`,
    `Active tasks: ${tasks.filter((task) => !["done", "failed", "rejected", "blocked", "cancelled"].includes(task.status)).length}`,
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
    "Working now:",
    ...(working.length > 0 ? working : ["- no agent running"]),
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
        `- ${provider.label}: ${provider.state}${provider.activeCount > 0 ? ` (${provider.activeCount} active)` : ""} - ${provider.detail}`
      ))
    ] : []),
    "",
    `Last event: ${lastEvent ? `${lastEvent.type} at ${lastEvent.createdAt}` : "none"}`
  ].join("\n");
}

export function formatProjects(projects: ProjectRecord[]): string {
  if (projects.length === 0) {
    return "No projects registered. Use /project_add key repository-path.";
  }

  return projects
    .map((project) => `${project.key} -> ${project.name} (${project.defaultBranch})`)
    .join("\n");
}

export function formatQueue(tasks: TaskRecord[]): string {
  if (tasks.length === 0) {
    return "Queue is empty.";
  }

  return tasks
    .map((task) => `#${task.id} ${task.projectKey ? `@${task.projectKey} ` : ""}[${task.status}] ${truncate(task.title || task.text, 120)}`)
    .join("\n");
}

function formatCostSummary(summary: ReturnType<MaestroDatabase["getCostSummary"]>): string {
  const totalTokens = summary.todayInputTokens + summary.todayOutputTokens;
  const lines: string[] = [
    "💰 Provider Economics & Cost Summary",
    "",
    `Today's cost: ${formatCurrencyUsd(summary.todayTotalUsd, { decimals: 4 })} USD`,
    `Today's tokens: ${totalTokens.toLocaleString()} (${summary.todayInputTokens.toLocaleString()} in / ${summary.todayOutputTokens.toLocaleString()} out)`
  ];

  if (summary.byProvider.length > 0) {
    lines.push("", "By provider:");
    for (const p of summary.byProvider) {
      const pTokens = p.inputTokens + p.outputTokens;
      lines.push(`• ${p.provider}: ${formatCurrencyUsd(p.costUsd, { decimals: 4 })} (${pTokens.toLocaleString()} tokens)`);
    }
  }

  if (summary.byProject.length > 0) {
    lines.push("", "By project:");
    for (const proj of summary.byProject) {
      const projTokens = proj.inputTokens + proj.outputTokens;
      lines.push(`• @${proj.projectKey}: ${formatCurrencyUsd(proj.costUsd, { decimals: 4 })} (${projTokens.toLocaleString()} tokens)`);
    }
  }

  return lines.join("\n");
}

function formatHelp(): string {
  return [
    "Octomynd Maestro is online.",
    "",
    "Commands:",
    "/status - show overall status and working agents",
    "/status @project - show project status",
    "/cost - show estimated token usage and costs by provider and project",
    "/projects - list projects",
    "/project_add key repository-path - register a project",
    "/intake @project text - classify and submit a request",
    "/intake_preview @project text - preview request classification",
    "/task @project text - create a task",
    "/followup task-id text - create a follow-up task",
    "/prepare id - create a local branch/worktree",
    "/cancel id - cancel an active or queued task",
    "/queue - list recent tasks",
    "/queue @project - list project tasks",
    "/graphs [@project] - list Work Graphs and budgets",
    "/graph_cancel id - cancel a graph, preserving evidence",
    "/features - list Feature Plans and Feature PRs",
    "/features @project - list project Feature Plans and Feature PRs",
    "/feature_priority id priority - change Feature Plan priority",
    "/feature_pause id [reason] - pause a Feature Plan",
    "/feature_resume id - resume a paused Feature Plan",
    "/feature_retry id [reason] - retry a blocked Feature Plan",
    "/feature_plan_cancel id [reason] - cancel a Feature Plan",
    "/improvements - list candidate improvements",
    "/improve_approve id - approve as a new Task + Feature Plan",
    "/improve_reject id - reject without deleting the audit trail",
    "/doctor [@project] - inspect the environment and providers",
    "/feature_cancel id [reason] - cancel a consolidated Feature PR",
    "/review id-or-url - request a manual final review",
    "/review_status id-or-url - check final review status",
    "/review_retry id-or-url - retry the final review",
    "/update - check and trigger a manual self-update"
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
      `Final review approved for Feature #${result.feature.id}!`,
      `Project: @${result.feature.projectKey}`,
      `PR: ${result.feature.pullRequestUrl}`,
      `Reviewer: ${result.providerId ?? result.feature.reviewerProvider ?? "configured provider"}`,
      "Status: Feature PR merged successfully."
    );
  } else if (result.status === "changes_requested") {
    lines.push(
      `Final review requested changes for Feature #${result.feature.id}.`,
      `Project: @${result.feature.projectKey}`,
      `PR: ${result.feature.pullRequestUrl}`,
      `Reviewer: ${result.providerId ?? result.feature.reviewerProvider ?? "configured provider"}`,
      `Changes: ${result.summary || result.message}`,
      "The PR was returned to draft for changes."
    );
  } else {
    lines.push(
      `Final review was not executed for Feature #${result.feature.id}.`,
      `Project: @${result.feature.projectKey}`,
      `PR: ${result.feature.pullRequestUrl}`,
      `Status: ${result.status}`,
      `Reason: ${result.message}`
    );
  }
  return lines.join("\n");
}

export function formatManualReviewStatusMessage(result: ManualReviewStatusResult): string {
  const { feature, prState, isReady, notReadyReason, isReviewActive } = result;
  const checksPassed = featureChecksPassed(prState);
  const lines: string[] = [
    `Final review status - Feature #${feature.id}`,
    `Project: @${feature.projectKey}`,
    `PR: ${feature.pullRequestUrl}`,
    `Maestro status: ${feature.status}${isReviewActive ? " (in progress)" : ""}`,
    `GitHub status: ${prState.state} | ${prState.isDraft ? "Draft" : "Ready"} | ${prState.mergeable}`,
    `Required checks: ${prState.checks.length > 0 ? (checksPassed ? "passed" : "pending/failed") : "none"}`,
    `Reviewer: ${feature.reviewerProvider ?? "None"}`
  ];

  if (feature.reviewSummary) {
    lines.push(`Last result: ${truncate(feature.reviewSummary, 200)}`);
  } else if (feature.lastError) {
    lines.push(`Last error: ${truncate(feature.lastError, 200)}`);
  }

  lines.push(`Ready for review: ${isReady ? "Yes" : `No (${notReadyReason ?? "target is not eligible"})`}`);

  return lines.join("\n");
}

export function formatWorkGraphs(
  graphs: WorkGraphView[],
  projectKey: string | null = null
): string {
  const filtered = graphs.filter((graph) => !projectKey || graph.projectKey === projectKey);
  if (filtered.length === 0) return "No Work Graphs registered.";
  return filtered.map((graph) => {
    const nodes = graph.nodes.flatMap((node) => {
      const attempts = node.attempts.map((attempt) => (
        `      #${attempt.attemptNumber} ${attempt.provider} [${attempt.status}] ${formatDuration(attempt.durationMs)}`
      ));
      return [
        `  - ${node.key} [${node.status}] ${node.mode === "writer" ? "WRITE" : "READ"} attempts ${node.attemptCount}/${node.maxAttempts}${node.fallbackCount ? `; fallbacks ${node.fallbackCount}` : ""}`,
        ...attempts
      ];
    });
    const adoption = graph.adoption
      ? `Adoption: ${graph.adoption.decision}/${graph.adoption.executionMode} (${graph.adoption.reason})`
      : "Adoption: no persisted event";
    return [
      `Graph #${graph.id} @${graph.projectKey ?? "inbox"} task #${graph.taskId} [${graph.status}]`,
      `${graph.objective}`,
      adoption,
      `Parallel readers: ${graph.maxParallelReaders}; artifacts: ${graph.artifactCount}`,
      `Canary: ${graph.canary.quality}; ${formatDuration(graph.canary.durationMs)}; attempts ${graph.canary.attempts}; fallbacks ${graph.canary.fallbacks}; conflicts ${graph.canary.conflicts}; tokens~${graph.canary.estimatedTokens}`,
      ...nodes,
      ...graph.artifacts.slice(0, 4).map((artifact) => `  artifact: ${artifact.key} (${artifact.kind}, ${artifact.bytes} bytes)`),
      ...(graph.cancellable
        ? [`  cancel: /graph_cancel ${graph.id}`]
        : [])
    ].join("\n");
  }).join("\n\n");
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "in progress";
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

export function formatImprovementCandidates(
  candidates: ReturnType<MaestroDatabase["listImprovementProposals"]>
): string {
  if (candidates.length === 0) return "No candidate improvements awaiting a decision.";
  return [
    "Candidate improvements:",
    ...candidates.map((item) => (
      `#${item.id} @${item.projectKey ?? "no-project"} [${item.risk}] ${truncate(item.title, 120)}`
    )),
    "",
    "Approval creates a Task + Feature Plan; it never applies a change directly."
  ].join("\n");
}

export function formatEnvironmentReport(report: EnvironmentDoctorReport): string {
  const failed = report.checks.filter((item) => item.status === "failed");
  return [
    `Environment Doctor @${report.projectKey}: ${report.status}`,
    report.summary,
    `Fingerprint: ${report.fingerprintId}`,
    `Action: ${report.recommendedAction}`,
    ...(failed.length > 0 ? ["", "Failures:", ...failed.map((item) => `- ${item.name}: ${item.summary}`)] : [])
  ].join("\n");
}

function formatFeatures(
  database: MaestroDatabase,
  plans: FeaturePlanDetails[],
  features: FeatureRecord[]
): string {
  if (plans.length === 0 && features.length === 0) {
    return "No Feature Plans or Feature PRs registered yet.";
  }

  const planLines = plans.slice(0, 8).flatMap((details) => {
    const { plan, tasks } = details;
    const blockers = tasks.filter((task) => task.taskStatus !== "awaiting_human");
    const eligible = plan.status === "queued" && tasks.length > 0 && blockers.length === 0;
    const integration = database.getFeaturePlanIntegrationDetailsByFeaturePlan(plan.id);
    const nextAction = plan.status === "blocked"
      ? `Resolve the blocker and run /feature_retry ${plan.id}`
      : plan.isPaused
      ? `Run /feature_resume ${plan.id} to resume`
      : plan.status === "queued" && eligible
      ? "Plan eligible for admission/start"
      : plan.status === "queued"
      ? "Waiting for dependencies or project release"
      : "Tasks are in progress with an agent";

    const lines = [
      `#${plan.id} @${plan.projectKey} [${plan.status}] priority:${plan.priority ?? 0}${plan.isPaused ? " [PAUSED]" : ""}${plan.status === "queued" ? (eligible ? " (eligible)" : " (waiting)") : ""} - ${truncate(plan.objective, 140)}`
    ];
    if (plan.pauseReason) {
      lines.push(`   pause reason: ${truncate(plan.pauseReason, 140)}`);
    }
    if (plan.blockedReason) {
      lines.push(`   blocker: ${truncate(plan.blockedReason, 140)}`);
    }
    if (blockers.length > 0) {
      lines.push(...blockers.map((task) => `   blocker: task #${task.taskId} (${task.taskStatus})`));
    }
    lines.push(`   next action: ${nextAction}`);
    if (integration) {
      lines.push(
        `   integration: ${integration.integration.status} (${integration.integration.checkpoint})`
        + (integration.integration.lastError ? ` - ${truncate(integration.integration.lastError, 160)}` : "")
      );
    }
    if (plan.cancelReason) {
      lines.push(`   cancelled: ${truncate(plan.cancelReason, 160)}`);
    }
    return lines;
  });

  const featureLines = features.slice(0, 8).map((feature) => (
    `#${feature.id} @${feature.projectKey} [${feature.status}] - ${feature.pullRequestUrl}`
    + (feature.lastError ? ` - ${truncate(feature.lastError, 160)}` : "")
  ));

  return [
    "Feature Plans:",
    ...(planLines.length > 0 ? planLines : ["- no plans"]),
    "",
    "Consolidated Feature PRs (review only these):",
    ...(featureLines.length > 0 ? featureLines : ["- no active features"])
  ].join("\n");
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}
