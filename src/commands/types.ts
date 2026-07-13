export type CommandChannel = "dashboard" | "telegram" | "whatsapp" | "maestro";

export type CommandOrigin = {
  channel: CommandChannel;
  userId?: string | null;
  username?: string | null;
};
