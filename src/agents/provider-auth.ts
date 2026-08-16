import { spawn } from "node:child_process";
import crypto from "node:crypto";

import { prepareCliSpawn, resolveCustomCliExecutable } from "./custom-cli.js";
import type { ProviderPreset } from "./provider-config.js";

export type ProviderAuthState = "waiting" | "connected" | "failed" | "cancelled";
export type ProviderAuthSession = {
  id: string;
  presetId: string;
  state: ProviderAuthState;
  verificationUrl: string | null;
  userCode: string | null;
  detail: string;
  startedAt: string;
  completedAt: string | null;
};
type InternalSession = ProviderAuthSession & { cancel?: () => void };

export class ProviderAuthBroker {
  private readonly sessions = new Map<string, InternalSession>();

  start(preset: ProviderPreset): ProviderAuthSession {
    if (!preset.authFlow || preset.authFlow === "none") throw new Error("provider_auth_flow_not_supported");
    const executable = resolveCustomCliExecutable(preset.command);
    if (!executable) throw new Error(`provider_cli_not_found:${preset.command}`);
    const session: InternalSession = {
      id: crypto.randomUUID(), presetId: preset.id, state: "waiting", verificationUrl: null,
      userCode: null, detail: "Preparando autorizacao segura.", startedAt: new Date().toISOString(), completedAt: null
    };
    this.sessions.set(session.id, session);
    if (preset.authFlow === "terminal") this.startTerminal(executable, preset, session);
    else this.startDeviceCode(executable, preset, session);
    return publicSession(session);
  }

  get(id: string): ProviderAuthSession | null {
    const session = this.sessions.get(id);
    return session ? publicSession(session) : null;
  }

  cancel(id: string): ProviderAuthSession | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.cancel?.();
    complete(session, "cancelled", "Autorizacao cancelada.");
    return publicSession(session);
  }

  private startDeviceCode(executable: string, preset: ProviderPreset, session: InternalSession) {
    // prepareCliSpawn already wraps .cmd/.bat shims via cmd.exe /c call <exe>.
    // Passing a TTY-less spawn keeps the device-code output on stdout for parsing.
    const invocation = prepareCliSpawn(executable, preset.authArgs ?? []);
    const child = spawn(invocation.command, invocation.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let openedUrl = "";
    const consume = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-20_000);
      const parsed = parseDeviceAuthorization(output);
      session.verificationUrl = parsed.verificationUrl ?? session.verificationUrl;
      session.userCode = parsed.userCode ?? session.userCode;
      session.detail = session.userCode ? "Aguardando voce autorizar no navegador." : "Preparando autorizacao segura.";
      if (session.verificationUrl && openedUrl !== session.verificationUrl) {
        openedUrl = session.verificationUrl;
        openExternalUrl(openedUrl);
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("error", (error) => complete(session, "failed", error.message));
    child.once("close", (code) => complete(session, code === 0 ? "connected" : "failed", code === 0 ? "Conta conectada." : cleanAuthError(output)));
    session.cancel = () => child.kill();
  }

  private startTerminal(executable: string, preset: ProviderPreset, session: InternalSession) {
    session.detail = "Terminal de autenticacao aberto. Conclua o login nele.";
    // Build "<exe> <auth args>" — quote only the executable path (it may contain
    // spaces); the bare auth args must NOT be individually quoted inside the
    // Start-Process -ArgumentList string or PowerShell treats each quoted token
    // as a separate command and fails (""auth"" é lido como token inválido).
    const exeQuoted = /\s/.test(executable) ? `"${executable.replace(/"/g, "")}"` : executable;
    const loginArgs = (preset.authArgs ?? []).join(" ");
    const command = `${exeQuoted} ${loginArgs}`.trim();
    // Open a visible PowerShell window that runs the login command and stays open.
    const script = `Start-Process powershell.exe -ArgumentList '-NoExit','-Command',${quotePowerShell(command)} -WorkingDirectory ${quotePowerShell(process.cwd())} -WindowStyle Normal`;
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true });
    child.once("error", (error) => complete(session, "failed", error.message));
    child.once("close", async () => {
      const connected = await probeStatus(executable, preset.authStatusArgs);
      complete(session, connected ? "connected" : "failed", connected ? "Conta conectada." : "O terminal foi fechado antes da conexao ser confirmada.");
    });
    session.cancel = () => child.kill();
  }
}

export function parseDeviceAuthorization(output: string) {
  // CLI device-code output often wraps the code/URL in ANSI color codes
  // (e.g. <ESC>[94mUEJ0-ANCUR<ESC>[0m) that break naive word-boundary regexes.
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  const verificationUrl = plain.match(/https?:\/\/[^\s"'<>]+/i)?.[0]?.replace(/[),.;]+$/, "") ?? null;
  // Standalone <LETTERS/DIGITS>-<LETTERS/DIGITS> device codes (e.g. UEJ0-ANCUR)
  // are the most reliable signal; prefer them over free-text "code:" labels.
  const standaloneCode = plain.match(/\b[A-Z0-9]{3,}(?:-[A-Z0-9]{4,})+\b/)?.[0];
  const labelledCode = plain.match(/(?:code|codigo)\s*[:=]?\s*([A-Z0-9]{3,}(?:-[A-Z0-9]{4,})+)/i)?.[1];
  return { verificationUrl, userCode: standaloneCode ?? labelledCode ?? null };
}

function complete(session: InternalSession, state: ProviderAuthState, detail: string) {
  if (session.state !== "waiting") return;
  session.state = state; session.detail = detail; session.completedAt = new Date().toISOString(); session.cancel = undefined;
}
function publicSession(session: InternalSession): ProviderAuthSession { const { cancel: _cancel, ...result } = session; return result; }
function quotePowerShell(value: string) { return `'${value.replace(/'/g, "''")}'`; }
function openExternalUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return;
    spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process ${quotePowerShell(parsed.toString())}`], { windowsHide: true, stdio: "ignore" });
  } catch { /* Ignore invalid provider output. */ }
}
async function probeStatus(command: string, args?: string[]): Promise<boolean> {
  if (!args?.length) return true;
  return new Promise((resolve) => {
    const invocation = prepareCliSpawn(command, args);
    const child = spawn(invocation.command, invocation.args, { windowsHide: true, stdio: "ignore", timeout: 15_000 });
    child.once("error", () => resolve(false)); child.once("close", (code) => resolve(code === 0));
  });
}
function cleanAuthError(output: string) { return output.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ") || "Autorizacao nao confirmada."; }
