// Browser-only stand-in for the Rust backend so the screens can be designed
// and reviewed with `npm run dev`. `?demo=fail` ends on the failure screen.
import type { Backend, SetupEvent, SetupInfo } from "./main";

const STAGES = [
  ["system", "Verificando o computador"],
  ["release", "Buscando a versão mais recente"],
  ["download", "Baixando o Maestro"],
  ["verify", "Conferindo a integridade"],
  ["install", "Instalando o aplicativo"],
  ["cli", "Registrando o comando maestro"],
  ["tools", "Procurando Git e agentes"]
] as const;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function demoBackend(): Backend {
  const handlers: Array<(event: SetupEvent) => void> = [];
  const emit = (event: SetupEvent) => handlers.forEach((handler) => handler(event));
  const params = new URLSearchParams(location.search);
  let cancelled = false;

  const run = async () => {
    cancelled = false;
    const stage = (name: string, state: "running" | "done" | "skipped" | "failed", detail?: string) => {
      emit({ type: "log", line: `[${name}] ${state}${detail ? `: ${detail}` : ""}` });
      emit({ type: "stage", name, state, detail });
    };
    const details: Record<string, string> = {
      system: "Windows pronto · 212,4 GB livres",
      release: "Maestro 0.4.1 · 114,2 MB",
      verify: "sha512 confere com o latest.yml",
      install: "Maestro 0.4.1 em C:\\Users\\voce\\AppData\\Local\\Programs\\Maestro",
      cli: "Disponível em terminais novos",
      tools: "Git, Codex encontrados"
    };
    for (const [name] of STAGES) {
      if (cancelled) {
        emit({ type: "finished", ok: false, error: "Instalação cancelada.", logPath: "demo.log" });
        return;
      }
      stage(name, "running");
      if (name === "download") {
        const total = 119_737_169;
        for (let received = 0; received <= total; received += total / 60) {
          if (cancelled) break;
          const mb = (value: number) => `${(value / 1_048_576).toFixed(1).replace(".", ",")} MB`;
          emit({ type: "progress", name, fraction: received / total, detail: `${mb(received)} de ${mb(total)} · 9,8 MB/s` });
          await wait(70);
        }
        stage(name, "done", "114,2 MB");
        continue;
      }
      if (name === "install") {
        for (let second = 1; second <= 4; second += 1) {
          emit({ type: "progress", name, fraction: null, detail: `Copiando os arquivos do app · ${second} s` });
          await wait(600);
        }
        if (params.get("demo") === "fail") {
          stage(name, "failed", "O instalador terminou com código 2.");
          emit({ type: "finished", ok: false, error: "O instalador terminou com código 2.", logPath: "demo.log" });
          return;
        }
      } else {
        await wait(650);
      }
      stage(name, "done", details[name]);
    }
    emit({
      type: "finished",
      ok: true,
      logPath: "demo.log",
      summary: {
        version: "0.4.1",
        updated: true,
        installDir: "C:\\Users\\voce\\AppData\\Local\\Programs\\Maestro",
        tools: [
          { id: "git", label: "Git", found: true, detail: "2.47.1.windows.1" },
          { id: "codex", label: "Codex", found: true, detail: "encontrado" },
          { id: "claude", label: "Claude Code", found: false, detail: null },
          { id: "gemini", label: "Gemini CLI", found: false, detail: null }
        ]
      }
    });
  };

  return {
    info: async (): Promise<SetupInfo> => ({
      stages: STAGES.map(([name, title]) => ({ name, title })),
      installDir: "C:\\Users\\voce\\AppData\\Local\\Programs\\Maestro",
      installedVersion: params.get("installed"),
      setupVersion: "0.4.1",
      localPayload: null
    }),
    start: async () => void run(),
    cancel: async () => void (cancelled = true),
    launch: async () => undefined,
    openLog: async () => undefined,
    onEvent: async (handler) => void handlers.push(handler),
    minimize: () => undefined,
    close: () => undefined
  };
}
