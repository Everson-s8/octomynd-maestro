export type CommandChannel = "dashboard" | "telegram" | "whatsapp";

export type CommandOrigin = {
  channel: CommandChannel;
  userId?: string | null;
  username?: string | null;
};
