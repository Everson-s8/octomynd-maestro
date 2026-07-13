import { Bot } from "grammy";
import { MaestroConfig } from "../config.js";
import { MaestroDatabase, ProjectRecord, TaskRecord } from "../db.js";
import { createProjectTask, parseProjectTaskInput, prepareTask, registerProject } from "../orchestrator.js";

export function createTelegramBot(config: MaestroConfig, database: MaestroDatabase) {
  const bot = new Bot(config.telegram.botToken);

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
    await ctx.reply(formatStatus(config.projectName, database, projectKey));
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

  bot.command("project_add", async (ctx) => {
    const input = parseProjectAddText(ctx.message?.text ?? "");
    if (!input) {
      await ctx.reply("Use: /project_add chave caminho-do-repo");
      return;
    }

    const result = registerProject(database, input);
    if (!result.ok) {
      await ctx.reply(["Projeto nao cadastrado.", ...result.errors].join("\n"));
      return;
    }

    database.addEvent({
      source: "telegram",
      type: "project.registered",
      text: result.project.key,
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null,
      metadata: {
        projectKey: result.project.key,
        defaultBranch: result.project.defaultBranch,
        warnings: result.warnings
      }
    });

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

    const project = taskInput.projectKey
      ? database.findProjectByKey(taskInput.projectKey)
      : database.getDefaultProject();

    if (!project) {
      await ctx.reply("Nenhum projeto cadastrado. Use /project_add chave caminho-do-repo.");
      return;
    }

    const task = createProjectTask(database, taskInput.text, project.key);
    database.addEvent({
      source: "telegram",
      type: "task.created",
      text: taskInput.text,
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null,
      taskId: task.id,
      metadata: {
        projectKey: project.key
      }
    });

    await ctx.reply(
      [
        `Task #${task.id} criada.`,
        `Projeto: ${project.key}`,
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

  bot.command("prepare", async (ctx) => {
    const taskId = parseTaskId(ctx.message?.text ?? "", "prepare");
    if (!taskId) {
      await ctx.reply("Use: /prepare 2");
      return;
    }

    const result = prepareTask(database, taskId, config.worktreesPath);
    if (!result.ok) {
      database.addEvent({
        source: "telegram",
        type: "task.prepare_failed",
        text: result.errors.join("\n"),
        userId: String(ctx.from?.id ?? ""),
        username: ctx.from?.username ?? null,
        taskId
      });
      await ctx.reply(["Prepare falhou.", ...result.errors].join("\n"));
      return;
    }

    database.addEvent({
      source: "telegram",
      type: "task.prepared",
      text: result.branchName,
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null,
      taskId: result.task.id,
      metadata: {
        branchName: result.branchName,
        worktreePrepared: true
      }
    });

    await ctx.reply(
      [
        `Task #${result.task.id} preparada.`,
        `Estado: ${result.task.status}`,
        `Branch: ${result.branchName}`,
        "Worktree isolada preparada."
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

export function parseTaskId(messageText: string, command: string): number | null {
  const regex = new RegExp(`^/${command}(?:@\\w+)?\\s+(\\d+)\\s*$`, "i");
  const match = messageText.match(regex);
  return match ? Number(match[1]) : null;
}

export function isUserAllowed(userId: number | undefined, allowedUserId: string | null): boolean {
  if (!allowedUserId) {
    return true;
  }
  return userId !== undefined && String(userId) === allowedUserId;
}

export function formatStatus(projectName: string, database: MaestroDatabase, projectKey: string | null = null): string {
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
    "",
    "Trabalhando agora:",
    ...(working.length > 0 ? working : ["- nenhum agente executando"]),
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
    "/queue - listar tasks recentes",
    "/queue @projeto - listar tasks do projeto"
  ].join("\n");
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}
