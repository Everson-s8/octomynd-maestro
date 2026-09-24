// Terminal visual identity for the Maestro CLI (banner, emblem, panel, status bar).
// Ported from the maestro-terminal design package; truecolor ANSI, honours NO_COLOR.
const RESET = "\u001b[0m";
const ANSI = /\u001b\[[0-9;]*m/g;

const COLORS = {
  ouro: "FFD98A",
  ambar: "FDB44E",
  laranja: "E0773F",
  brasa: "C24E1F",
  cobre: "B87840",
  vinho: "8C3313",
  marfim: "F2EDE4",
  cinza: "8A7D70",
  painel: "231A15"
} as const;
type ColorName = keyof typeof COLORS;

const GRADIENT = ["FFD98A", "FFC968", "FDB44E", "F6A042", "EE8C3A", "E57A34", "D9682D", "C24E1F"];
const EMBLEM_PALETTE = ["E0773F", "B84A1D", "FFC968", "F2EDE4", "18110D", "963816", "B87840"];

const FONT: Record<string, string[]> = {
  M: ["██   ██", "███ ███", "███████", "██ █ ██", "██   ██", "██   ██", "██   ██"],
  A: [" █████ ", "██   ██", "██   ██", "███████", "██   ██", "██   ██", "██   ██"],
  E: ["███████", "██     ", "██     ", "██████ ", "██     ", "██     ", "███████"],
  S: [" ██████", "██     ", "██     ", " █████ ", "     ██", "     ██", "██████ "],
  T: ["███████", "  ███  ", "  ███  ", "  ███  ", "  ███  ", "  ███  ", "  ███  "],
  R: ["██████ ", "██   ██", "██   ██", "██████ ", "██ ██  ", "██  ██ ", "██   ██"],
  O: [" █████ ", "██   ██", "██   ██", "██   ██", "██   ██", "██   ██", " █████ "]
};

// Shadow glyph by neighbours (up, down, left, right).
const SHADOW_BOX: Record<string, string> = {
  "0011": "═", "0010": "═", "0001": "═", "0000": "═", "1100": "║", "1000": "║", "0100": "║",
  "0101": "╔", "0110": "╗", "1001": "╚", "1010": "╝", "1101": "╠", "1110": "╣", "0111": "╦", "1011": "╩", "1111": "╬"
};

// "crista" octopus: glyphs, foreground and background palette indexes ("." = none).
const EMBLEM = {
  chars: [
    "             ▄▄▄▄▄▄▄▄", "          ▄█████▀▀█████▄", "        ▄████████████████▄", "       ▄██████████████████▄",
    "       ████████████████████", "      ▄███▀███▀████▀███▀▀███", "      █████▀▀▀███████▀▀▀█▀██", "       ███████▀█████▀██████",
    "      ▄███▀██▀▀████▀▀██▀███▄", "▄▄▄▄▀▀█▀▀████████▀███████▀▀█▀▀▄▄▄▄", "▀█▀▀▀█▀▀█▀▀████████████▀▀█▀█▀▀▀▀█▀",
    "▄▄▄▀█▀▀▀▄█▀▀▀▀▀████▀█▀▀██▄ ▀▀█▀▄▄▄", "▀██▀   ▄██▀ ▀██    ██▀ ▀██▀   ▀██▀", " ▀▀█▄▀▀█▀   ██▀     ██   ▀█▀▀▄█▀▀",
    "    ▀▀▀█▄▄▄██▀       ██▄▄▄█▀ ▀", "        ▀▀▀            ▀▀▀"
  ],
  foreground: [
    ".............00000011.............", "..........00000000011111..........", "........000002000000211111........",
    ".......00000000000001111111.......", ".......00000000000001111111.......", "......0000033300000033311111......",
    "......0003333333003333333111......", ".......00334444300334444311.......", "......0000333330000333331110......",
    "0000000000000000001111111100000000", "0555500500000000011111111055055550", "00105500155100001111111151.0550100",
    "5510...1511.515....515.1151...0155", ".51111151...155.....51...15111115.", "....5155555155.......5115555.5....",
    "........111............111........"
  ],
  background: [
    "..................................", "................22................", "..................................",
    "..................................", "..................................", "..........3...3....3...33.........",
    "...........444.......444.3........", "..............3.....3.............", "..........0..00....11..1..........",
    "....55.55........1.......55.55....", "5.000.50.15............55.0.5000.5", "...1.0....1.515....5.5......0.5...",
    "............1........1....5.......", "..5..55....................55..5..", "..................................",
    ".................................."
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

type Style = { fg?: string; bg?: string; bold?: boolean; italic?: boolean };

function rgb(hex: string): [number, number, number] {
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

function hexOf(value: string): string {
  return (COLORS as Record<string, string>)[value] ?? value.replace("#", "");
}

function paintWith(enabled: boolean) {
  return (text: string, style: Style = {}): string => {
    if (!enabled || !text) return text;
    const codes: string[] = [];
    if (style.bold) codes.push("1");
    if (style.italic) codes.push("3");
    if (style.fg) codes.push(`38;2;${rgb(hexOf(style.fg)).join(";")}`);
    if (style.bg) codes.push(`48;2;${rgb(hexOf(style.bg)).join(";")}`);
    return codes.length ? `\u001b[${codes.join(";")}m${text}${RESET}` : text;
  };
}

function mix(from: string, to: string, amount: number): string {
  const a = rgb(from);
  const b = rgb(to);
  return a.map((channel, index) => Math.round(channel + (b[index]! - channel) * amount).toString(16).padStart(2, "0")).join("");
}

function gradientAt(position: number): string {
  const segment = Math.max(0, Math.min(1, position)) * (GRADIENT.length - 1);
  const index = Math.min(Math.floor(segment), GRADIENT.length - 2);
  return mix(GRADIENT[index]!, GRADIENT[index + 1]!, segment - index);
}

function visibleLength(value: string): number {
  return Array.from(value.replace(ANSI, "")).length;
}

function pad(value: string, width: number): string {
  if (visibleLength(value) > width) {
    return `${Array.from(value.replace(ANSI, "")).slice(0, Math.max(0, width - 1)).join("")}…`;
  }
  return value + " ".repeat(Math.max(0, width - visibleLength(value)));
}

function bannerMask(text: string): boolean[][] {
  const rows = Array.from({ length: 7 }, () => "");
  for (const letter of text) {
    const glyph = FONT[letter];
    if (!glyph) continue;
    for (let row = 0; row < 7; row += 1) rows[row] += `${glyph[row]} `;
  }
  return rows.map((row) => Array.from(row, (cell) => cell === "█"));
}

// Full letters with a gradient plus an offset double-line outline as extrusion.
function banner(paint: ReturnType<typeof paintWith>, compact: boolean): string[] {
  const mask = bannerMask("MAESTRO");
  const height = mask.length;
  const width = mask[0]!.length;
  const filled = (row: number, column: number) => row >= 0 && row < height && column >= 0 && column < width && mask[row]![column]!;
  if (compact) {
    const out: string[] = [];
    for (let row = 0; row < 8; row += 2) {
      let line = "";
      for (let column = 0; column < width; column += 1) {
        const top = filled(row, column);
        const bottom = filled(row + 1, column);
        const topColor = gradientAt(row / 7);
        const bottomColor = gradientAt((row + 1) / 7);
        if (top && bottom) line += paint("▀", { fg: topColor, bg: bottomColor });
        else if (top) line += paint("▀", { fg: topColor });
        else if (bottom) line += paint("▄", { fg: bottomColor });
        else line += " ";
      }
      out.push(line.trimEnd());
    }
    return out;
  }
  const shadow = (row: number, column: number) => !filled(row, column) && filled(row - 1, column - 1);
  const out: string[] = [];
  for (let row = 0; row <= height; row += 1) {
    let line = "";
    for (let column = 0; column <= width; column += 1) {
      if (filled(row, column)) {
        line += paint("█", { fg: gradientAt(row / (height - 1)) });
      } else if (shadow(row, column)) {
        const key = [shadow(row - 1, column), shadow(row + 1, column), shadow(row, column - 1), shadow(row, column + 1)]
          .map((value) => (value ? "1" : "0")).join("");
        line += paint(SHADOW_BOX[key]!, { fg: "vinho" });
      } else {
        line += " ";
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

function emblem(paint: ReturnType<typeof paintWith>): string[] {
  return EMBLEM.chars.map((line, row) => Array.from(line).map((glyph, column) => {
    if (glyph === " ") return glyph;
    const fg = EMBLEM.foreground[row]![column];
    const bg = EMBLEM.background[row]![column];
    return paint(glyph, {
      fg: fg && fg !== "." ? EMBLEM_PALETTE[Number.parseInt(fg, 16)] : undefined,
      bg: bg && bg !== "." ? EMBLEM_PALETTE[Number.parseInt(bg, 16)] : undefined
    });
  }).join(""));
}

export function terminalColorEnabled(): boolean {
  return process.env.NO_COLOR === undefined && Boolean(process.stdout.isTTY);
}

export function terminalPrompt(enabled = terminalColorEnabled()): string {
  return paintWith(enabled)("❯ ", { fg: "laranja", bold: true });
}

export function renderTerminalWelcome(input: TerminalWelcome): string[] {
  const width = Math.max(40, Math.min(input.width ?? 110, 110));
  const enabled = input.color ?? terminalColorEnabled();
  const paint = paintWith(enabled);
  const pt = (input.locale ?? "pt-BR") === "pt-BR";
  const t = (ptText: string, enText: string) => (pt ? ptText : enText);

  const providers = input.providers.length
    ? input.providers.slice(0, 3).map((provider) => provider.label).join(", ") + (input.providers.length > 3 ? `, +${input.providers.length - 3}` : "")
    : t("nenhum conectado", "none connected");
  const mode = input.selectedProvider ?? t("automático", "automatic");
  const sections: Array<[string, Array<[string, string]>]> = [
    [t("Agentes em cena", "Agents on stage"), [[t("provedores", "providers"), providers]]],
    [t("Roteamento", "Routing"), [[t("modo", "mode"), mode]]],
    [t("Fila", "Queue"), [["", `${input.queuedTasks} ${t("aguardando", "queued")} · ${input.runningTasks} ${t("em execução", "running")}`]]],
    [t("Contexto", "Context"), [[t("projeto", "project"), `@${input.projectKey}`]]]
  ];
  const right: string[] = [];
  sections.forEach(([head, items], index) => {
    if (index) right.push("");
    right.push(paint(head, { fg: "ouro", bold: true }));
    for (const [key, value] of items) right.push((key ? paint(`${key}: `, { fg: "cobre" }) : "") + paint(value, { fg: "marfim" }));
  });
  const count = input.providers.length;
  right.push("", paint(`8 ${t("braços", "arms")} · ${count} ${count === 1 ? t("provedor", "provider") : t("provedores", "providers")} · `, { fg: "cinza" })
    + paint("/help", { fg: "ouro" }) + paint(t(" para comandos", " for commands"), { fg: "cinza" }));

  const lines = ["", ...banner(paint, width < 66), ""];

  const inner = width - 2;
  const art = width >= 76 ? emblem(paint) : [];
  const leftWidth = art.length ? Math.max(...art.map(visibleLength)) + 4 : 1;
  const height = Math.max(art.length, right.length);
  const artTop = Math.floor((height - art.length) / 2);
  const border = (text: string) => paint(text, { fg: "brasa" });
  const title = ` Octomynd Maestro v${input.version} · local `;
  const titleLeft = Math.floor((inner - visibleLength(title)) / 2);
  lines.push(border(`╭${"─".repeat(titleLeft)}`) + paint(title, { fg: "ouro", bold: true }) + border(`${"─".repeat(inner - titleLeft - visibleLength(title))}╮`));
  for (let row = 0; row < height; row += 1) {
    const left = row >= artTop && row < artTop + art.length ? `  ${art[row - artTop]}` : "";
    lines.push(border("│") + pad(left, leftWidth) + pad(right[row] ?? "", inner - leftWidth) + border("│"));
  }
  lines.push(border(`╰${"─".repeat(inner)}╯`), "");

  lines.push(paint(t("Bem-vindo ao Maestro. ", "Welcome to Maestro. "), { fg: "marfim", bold: true })
    + paint(t("Descreva a tarefa ou digite /help.", "Describe a task or type /help."), { fg: "marfim" }));
  lines.push(paint(t("✦ Dica: ", "✦ Tip: "), { fg: "ambar" })
    + paint(t("toda mudança espera sua aprovação antes do merge.", "every change waits for your approval before merge."), { fg: "cinza" }), "");

  const segment = (text: string, fg: ColorName, bold = false) => paint(` ${text} `, { fg, bg: "painel", bold });
  const separator = paint("│", { fg: "cinza", bg: "painel" });
  lines.push([
    segment("♪ maestro", "ouro", true),
    segment(`@${input.projectKey}`, "marfim"),
    segment(mode, "marfim"),
    segment(`${t("fila", "queue")} ${input.queuedTasks}`, "ambar")
  ].join(separator));
  lines.push(border("─".repeat(width)));
  return lines;
}
