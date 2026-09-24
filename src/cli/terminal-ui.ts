// Compact terminal welcome for the Maestro CLI. The warm palette follows the
// desktop setup visual language without imposing a background on the user's terminal.
const RESET = "\u001b[0m";

const COLORS = {
  orange: "E27A45",
  orangeLight: "EE9160",
  text: "EFE7DD",
  muted: "A89C8F",
  faint: "7A6F65"
} as const;
type ColorName = keyof typeof COLORS;

type Style = { fg?: ColorName; bold?: boolean };

function rgb(hex: string): [number, number, number] {
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

function paintWith(enabled: boolean) {
  return (text: string, style: Style = {}): string => {
    if (!enabled || !text) return text;
    const codes: string[] = [];
    if (style.bold) codes.push("1");
    if (style.fg) codes.push(`38;2;${rgb(COLORS[style.fg]).join(";")}`);
    return codes.length ? `\u001b[${codes.join(";")}m${text}${RESET}` : text;
  };
}

function fit(value: string, width: number): string {
  const chars = Array.from(value);
  if (chars.length <= width) return value;
  if (width <= 0) return "";
  return `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

export type TerminalProvider = { id: string; label: string };

export type TerminalWelcome = {
  projectKey: string;
  version: string;
  providers: TerminalProvider[];
  queuedTasks: number;
  runningTasks: number;
  selectedProvider?: string | null;
  width?: number;
  color?: boolean;
  locale?: "pt-BR" | "en";
};

export function terminalColorEnabled(): boolean {
  return process.env.NO_COLOR === undefined && Boolean(process.stdout.isTTY);
}

export function terminalPrompt(enabled = terminalColorEnabled()): string {
  return paintWith(enabled)("❯ ", { fg: "orange", bold: true });
}

export function renderTerminalWelcome(input: TerminalWelcome): string[] {
  const width = Math.max(40, Math.min(input.width ?? 88, 110));
  const paint = paintWith(input.color ?? terminalColorEnabled());
  const pt = (input.locale ?? "pt-BR") === "pt-BR";
  const t = (ptText: string, enText: string) => (pt ? ptText : enText);
  const separator = paint("─".repeat(width), { fg: "faint" });
  const labelWidth = 14;
  const valueWidth = width - labelWidth - 3;

  const providers = input.providers.length
    ? input.providers.map((provider) => provider.label).join(" · ")
    : t("nenhum conectado", "none connected");
  const mode = input.selectedProvider ?? t("automático", "automatic");
  const rows: Array<[string, string]> = [
    [t("Projeto", "Project"), `@${input.projectKey}`],
    [t("Provedores", "Providers"), providers],
    [t("Roteamento", "Routing"), mode],
    [t("Fila", "Queue"), `${input.queuedTasks} ${t("aguardando", "queued")} · ${input.runningTasks} ${t("em execução", "running")}`]
  ];

  const title = `Maestro v${input.version} · ${t("CLI local", "local CLI")}`;
  const lines = [
    "",
    paint(fit(title, width), { fg: "orangeLight", bold: true }),
    paint(fit(t("Seus agentes, coordenados com clareza.", "Your agents, clearly coordinated."), width), { fg: "muted" }),
    "",
    separator
  ];

  for (const [label, value] of rows) {
    lines.push(`${paint(label.padEnd(labelWidth), { fg: "muted" })}  ${paint(fit(value, valueWidth), { fg: "text" })}`);
  }

  lines.push(
    separator,
    paint(fit(t("Descreva a tarefa ou digite /help.", "Describe a task or type /help."), width), { fg: "text" }),
    ""
  );

  return lines;
}
