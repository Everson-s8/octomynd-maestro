import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { demoBackend } from "./demo";

export type StageState = "pending" | "running" | "done" | "skipped" | "failed";
export type StageInfo = { name: string; title: string };
export type ToolReport = { id: string; label: string; found: boolean; detail: string | null };
export type Summary = { version: string; installDir: string; tools: ToolReport[] };
export type SetupInfo = {
  stages: StageInfo[];
  installDir: string;
  installedVersion: string | null;
  setupVersion: string;
  localPayload: string | null;
};
export type SetupEvent =
  | { type: "stage"; name: string; state: Exclude<StageState, "pending">; detail?: string; durationMs?: number }
  | { type: "progress"; name: string; fraction: number | null; detail: string }
  | { type: "log"; line: string }
  | { type: "finished"; ok: boolean; error?: string; summary?: Summary; logPath: string };

export type Backend = {
  info(): Promise<SetupInfo>;
  start(): Promise<void>;
  cancel(): Promise<void>;
  launch(): Promise<void>;
  openLog(): Promise<void>;
  onEvent(handler: (event: SetupEvent) => void): Promise<void>;
  minimize(): void;
  close(): void;
};

const isTauri = "__TAURI_INTERNALS__" in window;

const tauriBackend: Backend = {
  info: () => invoke<SetupInfo>("setup_info"),
  start: () => invoke("start_setup"),
  cancel: () => invoke("cancel_setup"),
  launch: () => invoke("launch_maestro"),
  openLog: () => invoke("open_log"),
  onEvent: async (handler) => {
    await listen<SetupEvent>("setup", (event) => handler(event.payload));
  },
  minimize: () => void getCurrentWindow().minimize(),
  close: () => void getCurrentWindow().close()
};

const backend = isTauri ? tauriBackend : demoBackend();
const app = document.querySelector<HTMLElement>("#app")!;

type StageView = StageInfo & { state: StageState; detail: string; fraction: number | null };
const state = {
  info: null as SetupInfo | null,
  stages: [] as StageView[],
  log: [] as string[],
  logOpen: false,
  installing: false
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const wordmark = (size: number) =>
  `<h1 class="maestro-marca" style="font-size:${size}px">Maestro<span class="maestro-ponto" aria-hidden="true"></span></h1>`;

const ICONS: Record<StageState, string> = {
  pending: `<span class="icon"><span class="icon-pending"></span></span>`,
  running: `<span class="icon"><span class="icon-running"></span></span>`,
  done: `<span class="icon icon-done"><svg viewBox="0 0 14 14"><path d="M2.5 7.4l3 3 6-6.6"/></svg></span>`,
  skipped: `<span class="icon icon-skipped"><svg viewBox="0 0 14 14"><path d="M3.5 7h7"/></svg></span>`,
  failed: `<span class="icon icon-failed"><svg viewBox="0 0 14 14"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg></span>`
};

function renderWelcome(): void {
  const info = state.info!;
  const updating = info.installedVersion !== null;
  const meta = [
    updating ? `<span>Maestro <b>${escapeHtml(info.installedVersion!)}</b> já instalado · será atualizado</span>` : "",
    `<span class="mono">${escapeHtml(info.installDir)}</span>`,
    info.localPayload ? `<span class="mono">Pacote local · ${escapeHtml(info.localPayload)}</span>` : ""
  ].join("");
  app.innerHTML = `
    <section class="screen welcome">
      <div class="batuta" aria-hidden="true"></div>
      ${wordmark(132)}
      <p class="welcome-lead">Seus agentes de código, regidos no seu computador.</p>
      <p class="welcome-copy">Vamos baixar a versão mais recente, conferir a integridade e deixar o app e o comando <span class="mono">maestro</span> prontos. Leva poucos minutos e não pede administrador.</p>
      <div class="welcome-actions">
        <button class="btn btn-primary" id="install" type="button">${updating ? "Atualizar" : "Instalar"}</button>
        <div class="welcome-meta">${meta}</div>
      </div>
    </section>`;
  const button = document.querySelector<HTMLButtonElement>("#install")!;
  button.focus();
  button.addEventListener("click", () => void start());
}

function stageRow(stage: StageView): string {
  const mini = stage.name === "download" && stage.state === "running" && stage.fraction !== null
    ? `<div class="step-mini"><i style="width:${(stage.fraction * 100).toFixed(1)}%"></i></div>`
    : "";
  return `
    <li class="step" data-state="${stage.state}">
      ${ICONS[stage.state]}
      <span class="step-title">${escapeHtml(stage.title)}</span>
      <span class="step-detail mono" title="${escapeHtml(stage.detail)}">${escapeHtml(stage.detail)}</span>
      ${mini}
    </li>`;
}

function overallFraction(): number {
  const total = state.stages.length || 1;
  const finished = state.stages.filter((stage) => ["done", "skipped"].includes(stage.state)).length;
  const running = state.stages.find((stage) => stage.state === "running");
  return Math.min(1, (finished + (running?.fraction ?? (running ? 0.35 : 0))) / total);
}

function renderProgress(): void {
  app.innerHTML = `
    <section class="screen progress">
      <div class="progress-head">
        <div>
          <h2 class="progress-title">Preparando o Maestro</h2>
          <p class="progress-sub">Instalação só para o seu usuário. Pode continuar usando o computador.</p>
        </div>
        <span class="progress-count mono" id="count"></span>
      </div>
      <div class="bar"><div class="bar-fill" id="bar"></div></div>
      <ul class="steps" id="steps"></ul>
      <div class="progress-foot">
        <button class="link" id="toggle-log" type="button" aria-expanded="false" aria-controls="log">
          <svg viewBox="0 0 10 10"><path d="M3.5 2l3 3-3 3"/></svg><span>Mostrar detalhes</span>
        </button>
        <button class="btn btn-ghost" id="cancel" type="button">Cancelar</button>
      </div>
      <pre class="log" id="log" hidden></pre>
    </section>`;
  document.querySelector("#toggle-log")!.addEventListener("click", toggleLog);
  document.querySelector("#cancel")!.addEventListener("click", () => {
    const button = document.querySelector<HTMLButtonElement>("#cancel")!;
    button.disabled = true;
    button.textContent = "Cancelando…";
    void backend.cancel();
  });
  updateProgress();
}

function updateProgress(): void {
  const steps = document.querySelector("#steps");
  if (!steps) return;
  steps.innerHTML = state.stages.map(stageRow).join("");
  const finished = state.stages.filter((stage) => ["done", "skipped"].includes(stage.state)).length;
  document.querySelector("#count")!.textContent = `${finished} de ${state.stages.length}`;
  (document.querySelector("#bar") as HTMLElement).style.width = `${(overallFraction() * 100).toFixed(1)}%`;
  // Cancelling while NSIS copies files would leave a half-installed app.
  const pastPointOfNoReturn = state.stages.some((stage) => ["install", "cli", "tools"].includes(stage.name) && stage.state !== "pending");
  const cancel = document.querySelector<HTMLButtonElement>("#cancel");
  if (cancel) cancel.hidden = pastPointOfNoReturn;
}

function toggleLog(): void {
  state.logOpen = !state.logOpen;
  const log = document.querySelector<HTMLElement>("#log")!;
  const toggle = document.querySelector<HTMLElement>("#toggle-log")!;
  log.hidden = !state.logOpen;
  toggle.setAttribute("aria-expanded", String(state.logOpen));
  toggle.querySelector("span")!.textContent = state.logOpen ? "Ocultar detalhes" : "Mostrar detalhes";
  if (state.logOpen) {
    log.textContent = state.log.join("\n");
    log.scrollTop = log.scrollHeight;
  }
}

function appendLog(line: string): void {
  state.log.push(line);
  if (state.log.length > 2000) state.log.shift();
  const log = document.querySelector<HTMLElement>("#log");
  if (log && state.logOpen) {
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    log.textContent += `${log.textContent ? "\n" : ""}${line}`;
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
}

function renderDone(summary: Summary): void {
  const tools = summary.tools.map((tool) => `
    <li>
      ${tool.found ? ICONS.done : ICONS.skipped}
      <strong>${escapeHtml(tool.label)}</strong>
      <span class="mono">${escapeHtml(tool.found ? tool.detail ?? "encontrado" : "não encontrado")}</span>
    </li>`).join("");
  const missingAgents = summary.tools.filter((tool) => tool.id !== "git" && !tool.found).length === summary.tools.length - 1;
  app.innerHTML = `
    <section class="screen result">
      <div class="batuta" aria-hidden="true"></div>
      <h2 class="result-title">O Maestro está pronto</h2>
      <p class="result-sub">Versão <span class="mono">${escapeHtml(summary.version)}</span> instalada em <span class="mono">${escapeHtml(summary.installDir)}</span>.</p>
      <ul class="found">${tools}</ul>
      <p class="found-hint">${missingAgents
        ? "Nenhum agente de código foi encontrado ainda. Instale o Codex, o Claude Code ou outro provedor e conecte nas configurações do Maestro."
        : "Conecte os agentes encontrados nas configurações do Maestro."}
        Num terminal novo, digite <code>maestro</code>.</p>
      <div class="result-actions">
        <button class="btn btn-ghost" id="open-log" type="button">Ver log</button>
        <span class="spacer"></span>
        <button class="btn btn-ghost" id="finish" type="button">Fechar</button>
        <button class="btn btn-primary" id="launch" type="button">Abrir o Maestro</button>
      </div>
    </section>`;
  document.querySelector("#launch")!.addEventListener("click", async () => {
    try {
      await backend.launch();
      backend.close();
    } catch (error) {
      renderFailure(String(error), false);
    }
  });
  document.querySelector("#finish")!.addEventListener("click", () => backend.close());
  document.querySelector("#open-log")!.addEventListener("click", () => void backend.openLog());
}

function renderFailure(error: string, cancelled: boolean): void {
  const failed = state.stages.find((stage) => stage.state === "failed");
  app.innerHTML = `
    <section class="screen result">
      <div class="batuta" aria-hidden="true"></div>
      <h2 class="result-title">${cancelled ? "Instalação cancelada" : "A instalação não terminou"}</h2>
      ${cancelled
        ? `<p class="result-sub">Nada foi instalado. Você pode começar de novo quando quiser.</p>`
        : `<p class="result-error">${escapeHtml(error)}</p>
           <p class="result-sub">${failed ? `Parou em <strong>${escapeHtml(failed.title.toLowerCase())}</strong>. ` : ""}O log tem cada comando e a resposta dele.</p>`}
      <div class="result-actions">
        <button class="btn btn-ghost" id="open-log" type="button">Abrir log</button>
        <span class="spacer"></span>
        <button class="btn btn-ghost" id="finish" type="button">Fechar</button>
        <button class="btn btn-primary" id="retry" type="button">Tentar de novo</button>
      </div>
    </section>`;
  document.querySelector("#retry")!.addEventListener("click", () => void start());
  document.querySelector("#finish")!.addEventListener("click", () => backend.close());
  document.querySelector("#open-log")!.addEventListener("click", () => void backend.openLog());
}

function handleEvent(event: SetupEvent): void {
  if (event.type === "log") return appendLog(event.line);
  if (event.type === "stage") {
    const stage = state.stages.find((candidate) => candidate.name === event.name);
    if (stage) {
      stage.state = event.state;
      stage.fraction = event.state === "running" ? null : stage.fraction;
      stage.detail = event.detail ?? (event.state === "running" ? "" : stage.detail);
    }
    return updateProgress();
  }
  if (event.type === "progress") {
    const stage = state.stages.find((candidate) => candidate.name === event.name);
    if (stage && stage.state === "running") {
      stage.fraction = event.fraction;
      stage.detail = event.detail;
      updateProgress();
    }
    return;
  }
  state.installing = false;
  if (event.ok && event.summary) renderDone(event.summary);
  else renderFailure(event.error ?? "Erro desconhecido.", event.error === "Instalação cancelada.");
}

async function start(): Promise<void> {
  if (state.installing) return;
  state.installing = true;
  state.log = [];
  state.logOpen = false;
  state.stages = state.info!.stages.map((stage) => ({ ...stage, state: "pending", detail: "", fraction: null }));
  renderProgress();
  try {
    await backend.start();
  } catch (error) {
    state.installing = false;
    renderFailure(String(error), false);
  }
}

async function boot(): Promise<void> {
  document.querySelector("#minimize")!.addEventListener("click", () => backend.minimize());
  document.querySelector("#close")!.addEventListener("click", () => {
    if (state.installing) void backend.cancel();
    backend.close();
  });
  await backend.onEvent(handleEvent);
  state.info = await backend.info();
  // Fonts are local; wait for them so the wordmark never flashes in Georgia.
  await document.fonts.ready;
  renderWelcome();
}

void boot();
