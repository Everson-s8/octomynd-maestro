import { Bot, Context } from "grammy";
import { MaestroConfig } from "../config.js";
import { MaestroDatabase, TaskRecord } from "../db.js";

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

    await ctx.reply(
      [
        "Octomynd Maestro esta online.",
        "",
        "Comandos:",
        "/status - ver estado atual",
        "/task <texto> - criar uma task local",
        "/queue - listar tasks recentes"
      ].join("\n")
    );
  });

  bot.command("status", async (ctx) => {
    database.addEvent({
      source: "telegram",
      type: "command.status",
      text: "/status",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null
    });

    await ctx.reply(formatStatus(config.projectName, database));
  });

  bot.command("task", async (ctx) => {
    const text = parseTaskText(ctx.message?.text ?? "");
    if (!text) {
      await ctx.reply("Use: /task descrever a demanda");
      return;
    }

    const task = database.createTask(text, "telegram");
    database.addEvent({
      source: "telegram",
      type: "task.created",
      text,
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null,
      taskId: task.id
    });

    await ctx.reply(`Task #${task.id} criada.\nStatus: ${task.status}\nDemanda: ${task.text}`);
  });

  bot.command("queue", async (ctx) => {
    database.addEvent({
      source: "telegram",
      type: "command.queue",
      text: "/queue",
      userId: String(ctx.from?.id ?? ""),
      username: ctx.from?.username ?? null
    });

    await ctx.reply(formatQueue(database.listTasks(10)));
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
      await ctx.reply("Comando nao reconhecido. Use /status, /task ou /queue.");
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

export function isUserAllowed(userId: number | undefined, allowedUserId: string | null): boolean {
  if (!allowedUserId) {
    return true;
  }
  return userId !== undefined && String(userId) === allowedUserId;
}

export function formatStatus(projectName: string, database: MaestroDatabase): string {
  const counts = database.countTasksByStatus();
  const lastEvent = database.getLastEvent();

  return [
    `Maestro: online`,
    `Projeto: ${projectName}`,
    `Tasks queued: ${counts.queued ?? 0}`,
    `Tasks done: ${counts.done ?? 0}`,
    `Tasks failed: ${counts.failed ?? 0}`,
    `Ultimo evento: ${lastEvent ? `${lastEvent.type} em ${lastEvent.createdAt}` : "nenhum"}`
  ].join("\n");
}

export function formatQueue(tasks: TaskRecord[]): string {
  if (tasks.length === 0) {
    return "Fila vazia.";
  }

  return tasks
    .map((task) => `#${task.id} [${task.status}] ${truncate(task.text, 120)}`)
    .join("\n");
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}
