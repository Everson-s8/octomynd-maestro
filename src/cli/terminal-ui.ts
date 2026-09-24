const RESET = "\u001b[0m";
const PALETTE = ["#E0773F", "#B84A1D", "#FFC968", "#F2EDE4", "#18110D", "#963816", "#B87840"];
const GRADIENT = ["#FFE08A", "#E0773F", "#B84A1D"];

const WORDMARK: Record<string, string[]> = {
  M: ["██   ██", "███ ███", "███████", "██ █ ██", "██   ██", "██   ██", "██   ██"],
  A: [" █████ ", "██   ██", "██   ██", "███████", "██   ██", "██   ██", "██   ██"],
  E: ["███████", "██     ", "██     ", "██████ ", "██     ", "██     ", "███████"],
  S: [" ██████", "██     ", "██     ", " █████ ", "     ██", "     ██", "██████ "],
  T: ["███████", "  ███  ", "  ███  ", "  ███  ", "  ███  ", "  ███  ", "  ███  "],
  R: ["██████ ", "██   ██", "██   ██", "██████ ", "██ ██  ", "██  ██ ", "██   ██"],
  O: [" █████ ", "██   ██", "██   ██", "██   ██", "██   ██", "██   ██", " █████ "]
};

const MASCOT = {
  chars: [
    "         ▄▄          ▄▄  ▄██", "         ▀█▄        ▄██ ▀█▀", "          ██▄▄▄▄▄▄▄▄████▀▀",
    "        ▄▄███▀▀▀▀▀▀█▀▀█▀", "      ▄███▀█▀▀█▀▀▀▀██▀███▄", "▀████▄██▀▀███▀███▀▀█▀▀████▄▄███▀",
    "   ▀▀███▀███▀███▀██▀███████▀▀", "    ██▀███▀███▀▀█▀▀██████▀██", "    █████▀███▀██▀███████████",
    "    ███████▀▀█▀▀███████▀█▀██", "  ▄▄███▀█▀▀██▀▀█████▀▀█▀▀██▀▄▄", "▄██▀▀▀███▀██████████▀▀█▀██▀▀▀▀██",
    "       ▀▀█▀▀█▀▀▀▀▀▀█▀▀██▀", "     ▄▀████████▀▀█████▀", "   ▄▀█▀▀▀ ██▀▀▀▀▀▀▀▀██",
    "   █████ ██▀        ▀██", "    ▀▀▀  ▀            ▀"
  ],
  foreground: [
    ".........66..........66..422....", ".........666........666.434.....", "..........6600000000664334......",
    "........0000000000000433........", "......00000444004444334000......", "66666000040000111143344400066666",
    "...66004400001111334111440066...", "....000400011114334111114000....", "....004400111133311111114400....",
    "....000411114334111111114400....", "..6660044113334111111155400066..", "66666000443341111111554400066666",
    ".......043344111111444000.......", ".....443340000044000000.........", "...446434.660000000066..........",
    "...46664.666........666.........", "....444..6............6........."
  ],
  background: [
    "................................", "........................3.......", "........................4.......",
    ".............444444.43.4........", "..........4.00.1111..4..........", "........40...1...43.41..........",
    "........0...1...4..1.......0....", "......4...1...43.41......4......", ".........1...4..4...............",
    "...........43.41.......5.0......", ".......0.44..41.....55.40..6....", ".........3..........14.0........",
    ".......43.40.444444.00..........", "......3........00...............", "....6.64........................",
    "................................", "................................"
  ]
};

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

function color(hex: string, enabled: boolean): string {
  if (!enabled) return "";
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `\u001b[38;2;${r};${g};${b}m`;
}

function paint(text: string, hex: string, enabled: boolean, bold = false): string {
  if (!enabled) return text;
  return `${bold ? "\u001b[1m" : ""}${color(hex, true)}${text}${RESET}`;
}

function gradientAt(position: number): string {
  const segment = position * (GRADIENT.length - 1);
  const index = Math.min(Math.floor(segment), GRADIENT.length - 2);
  const amount = segment - index;
  const from = GRADIENT[index]!.slice(1);
  const to = GRADIENT[index + 1]!.slice(1);
  const channels = [0, 2, 4].map((offset) => {
    const start = Number.parseInt(from.slice(offset, offset + 2), 16);
    const end = Number.parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(start + (end - start) * amount).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

function logo(enabled: boolean, width: number): string[] {
  const rows = Array.from({ length: 7 }, (_, row) =>
    Array.from("MAESTRO", (letter) => `${WORDMARK[letter]![row]} `).join("").split("")
  );
  const isFilled = (row: number, column: number) => Boolean(rows[row]?.[column] === "█");
  const output: string[] = [];
  for (let row = 0; row < 8; row += 1) {
    let line = "";
    for (let column = 0; column < (rows[0]?.length ?? 0) + 1; column += 1) {
      if (isFilled(row, column)) {
        line += paint("█", gradientAt(row / 6), enabled, true);
      } else if (row > 0 && column > 0 && isFilled(row - 1, column - 1)) {
        line += paint("═", row < 3 ? PALETTE[0]! : PALETTE[1]!, enabled);
      } else {
        line += " ";
      }
    }
    output.push(line.trimEnd());
  }
  const maxLine = Math.max(...output.map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").length));
  return width > 0 && maxLine > width ? output.map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").slice(0, width)) : output;
}

function mascotLines(enabled: boolean): string[] {
  return MASCOT.chars.map((line, row) => {
    const chars = Array.from(line);
    const foreground = MASCOT.foreground[row] ?? "";
    const background = MASCOT.background[row] ?? "";
    return chars.map((glyph, column) => {
      if (glyph === " ") return glyph;
      const fg = foreground[column];
      const bg = background[column];
      const fgColor = fg && fg !== "." ? PALETTE[Number.parseInt(fg, 16)] : undefined;
      const bgColor = bg && bg !== "." ? PALETTE[Number.parseInt(bg, 16)] : undefined;
      if (!enabled) return glyph;
      const codes = [fgColor ? color(fgColor, true).slice(2, -1) : "", bgColor ? `48;2;${Number.parseInt(bgColor.slice(1, 3), 16)};${Number.parseInt(bgColor.slice(3, 5), 16)};${Number.parseInt(bgColor.slice(5, 7), 16)}` : ""].filter(Boolean);
      return codes.length ? `\u001b[${codes.join(";")}m${glyph}${RESET}` : glyph;
    }).join("").trimEnd();
  });
}

function visibleLength(value: string): number {
  return Array.from(value.replace(/\u001b\[[0-9;]*m/g, "")).length;
}

function fit(value: string, width: number): string {
  if (visibleLength(value) > width) {
    const plain = value.replace(/\u001b\[[0-9;]*m/g, "");
    return `${Array.from(plain).slice(0, Math.max(0, width - 1)).join("")}…`;
  }
  return value + " ".repeat(Math.max(0, width - visibleLength(value)));
}

export function renderTerminalWelcome(input: TerminalWelcome): string[] {
  const width = Math.max(68, Math.min(input.width ?? 108, 120));
  const enabled = input.color ?? (process.env.NO_COLOR === undefined && Boolean(process.stdout.isTTY));
  const pt = (input.locale ?? "pt-BR") === "pt-BR";
  const border = (text: string) => paint(text, PALETTE[0]!, enabled);
  const lines = ["", ...logo(enabled, width), ""];
  const art = mascotLines(enabled);
  const leftWidth = Math.min(36, Math.max(30, Math.max(...art.map(visibleLength)) + 2));
  const innerWidth = width - 2;
  const rightWidth = innerWidth - leftWidth - 3;
  const providers = input.providers.length
    ? input.providers.slice(0, 4).map((provider) => provider.label).join(", ")
    : (pt ? "nenhum conectado" : "none connected");
  const section = [
    paint(pt ? "Agentes conectados" : "Connected agents", PALETTE[2]!, enabled, true),
    `${paint(pt ? "providers: " : "providers: ", PALETTE[6]!, enabled)}${fit(providers, Math.max(1, rightWidth - 11)).trimEnd()}`,
    "",
    paint(pt ? "Roteamento" : "Routing", PALETTE[2]!, enabled, true),
    `${paint(pt ? "modo: " : "mode: ", PALETTE[6]!, enabled)}${input.selectedProvider ?? (pt ? "automático" : "automatic")}`,
    "",
    paint(pt ? "Fila global" : "Global queue", PALETTE[2]!, enabled, true),
    `${input.queuedTasks} ${pt ? "aguardando" : "queued"} · ${input.runningTasks} ${pt ? "em execução" : "running"}`,
    "",
    paint(`${pt ? "Contexto ativo" : "Active context"}: @${input.projectKey}`, PALETTE[3]!, enabled, true),
    paint(pt ? "/help para ver os comandos" : "/help to see commands", PALETTE[6]!, enabled)
  ];
  const title = ` Octomynd Maestro v${input.version} · local `;
  const topFill = Math.max(0, innerWidth - visibleLength(title));
  lines.push(border(`╭${"─".repeat(Math.floor(topFill / 2))}`) + paint(title, PALETTE[2]!, enabled, true) + border(`${"─".repeat(Math.ceil(topFill / 2))}╮`));
  const height = Math.max(art.length, section.length);
  const artTop = Math.floor((height - art.length) / 2);
  for (let row = 0; row < height; row += 1) {
    const artLine = row >= artTop && row < artTop + art.length ? art[row - artTop]! : "";
    const content = section[row] ?? "";
    lines.push(border("│ ") + fit(artLine, leftWidth) + " │ " + fit(content, rightWidth) + border("│"));
  }
  lines.push(border(`╰${"─".repeat(innerWidth)}╯`), "");
  lines.push(`${paint(pt ? "Bem-vindo ao Maestro." : "Welcome to Maestro.", PALETTE[3]!, enabled, true)} ${pt ? "Descreva a tarefa ou digite /help." : "Describe a task or type /help."}`);
  lines.push(`${paint("✦ ", PALETTE[2]!, enabled)}${paint(pt ? "O contexto do projeto é aplicado automaticamente." : "Project context is applied automatically.", PALETTE[6]!, enabled)}`, "");
  const mode = input.selectedProvider ?? (pt ? "roteamento automático" : "automatic routing");
  const status = `♫ maestro  │  @${input.projectKey}  │  ${mode}  │  fila global ${input.queuedTasks}`;
  lines.push(paint(status, PALETTE[2]!, enabled, true));
  lines.push(border("─".repeat(width)));
  lines.push(`${paint("❯ ", PALETTE[0]!, enabled, true)}${paint(pt ? "Descreva a tarefa para o Maestro" : "Describe the task for Maestro", PALETTE[6]!, enabled)}`);
  return lines;
}
