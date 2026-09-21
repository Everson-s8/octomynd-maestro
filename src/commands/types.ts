export type CommandChannel = "dashboard" | "telegram" | "whatsapp" | "maestro" | "cli";

export type CommandOrigin = {
  channel: CommandChannel;
  userId?: string | null;
  username?: string | null;
};
