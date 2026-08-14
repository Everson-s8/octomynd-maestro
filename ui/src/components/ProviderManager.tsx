import { useEffect, useState } from "react";
import {
  deleteProvider,
  fetchProviderPresets,
  ProviderConnectionMode,
  ProviderPreset,
  registerProvider,
  RegisteredCustomProvider,
  testProviderConnection
} from "../api";

type ConnState = "idle" | "testing" | "saving";

/**
 * Gestão de providers custom: escolha um preset (claude, codex, deepseek,
 * ollama, anthropic, etc.), selecione o modo de conexão (conta / API key /
 * local), teste a conexão e registre (persiste em MAESTRO_CUSTOM_PROVIDERS no
 * .env). Também permite remover um provider já registrado.
 *
 * A ativação num processo Maestro em execução acontece no próximo start (o
 * registro persiste o .env; index.ts carrega custom providers no boot).
 */
export function ProviderManager() {
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [registered, setRegistered] = useState<RegisteredCustomProvider[]>([]);
  const [presetId, setPresetId] = useState("");
  const [connectionMode, setConnectionMode] = useState<ProviderConnectionMode>("account");
  const [label, setLabel] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [model, setModel] = useState("");
  const [connState, setConnState] = useState<ConnState>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connDetail, setConnDetail] = useState<string | null>(null);
  const [registeredOk, setRegisteredOk] = useState(false);

  const load = async () => {
    try {
      const data = await fetchProviderPresets();
      setPresets(data.presets);
      setRegistered(data.registered);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao carregar presets.");
    }
  };
  useEffect(() => { void load(); }, []);

  const currentPreset = presets.find((p) => p.id === presetId);

  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    setConnectionMode(preset.connectionHint);
    setLabel(preset.label);
    setCommand(preset.command);
    setArgs((preset.args ?? []).join(" "));
    setModel(preset.models?.[0] ?? "");
    setError("");
    setNotice("");
  };

  const test = async () => {
    if (!command.trim()) { setError("Informe o comando do provider."); return; }
    setConnState("testing");
    setError(""); setNotice(""); setConnDetail(null);
    try {
      const result = await testProviderConnection({ command: command.trim(), args: args.split(/\s+/).filter(Boolean) });
      if (result.ok) {
        setConnDetail("✓ Conectado — o executável foi encontrado.");
        setNotice("");
      } else {
        setConnDetail(`✗ ${result.detail || "Falha na conexão"}`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível testar a conexão.");
    } finally {
      setConnState("idle");
    }
  };

  const save = async () => {
    if (!command.trim()) { setError("Informe o comando."); return; }
    const id = currentPreset?.id ?? sanitizeId(label || command);
    setConnState("saving"); setError(""); setNotice(""); setRegisteredOk(false);
    try {
      await registerProvider({
        id,
        label: label || currentPreset?.label || id,
        command: command.trim(),
        args: args.split(/\s+/).filter(Boolean),
        model: model.trim() || null,
        presetId: currentPreset?.id,
        connectionMode
      });
      setNotice(`Provider "${label || id}" registrado no .env. Vai valer no próximo start do Maestro.`);
      setRegisteredOk(true);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível registrar.");
    } finally {
      setConnState("idle");
    }
  };

  const remove = async (id: string) => {
    setError(""); setNotice("");
    try {
      const next = await deleteProvider(id);
      setRegistered(next);
      setNotice(`Provider "${id}" removido do .env.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível remover.");
    }
  };

  return (
    <section className="panel provider-manager" id="provider-manager">
      <div className="panel-head">
        <div><div className="lbl">Conectar & gestão</div><h3>Adicionar provider</h3></div>
        <div className="count">{registered.length} custom</div>
      </div>

      {error ? <p className="provider-error">{error}</p> : null}
      {notice ? <p className="provider-notice">{notice}</p> : null}

      <div className="provider-connect">
        <label className="field">
          <span>Preset (opcional)</span>
          <select value={presetId} onChange={(event) => applyPreset(event.target.value)}>
            <option value="">— Escolher um preset —</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>{p.label} · {p.command} {p.args?.join(" ") ?? ""}</option>
            ))}
          </select>
          {currentPreset ? <small>{currentPreset.description}</small> : <small>Ex: claude, codex, deepseek, ollama, anthropic, opencode-go...</small>}
        </label>

        <label className="field">
          <span>Modo de conexão</span>
          <select value={connectionMode} onChange={(event) => setConnectionMode(event.target.value as ProviderConnectionMode)}>
            <option value="account">Conta (login / navegador / OAuth)</option>
            <option value="api_key">API key (chave via variável de ambiente)</option>
            <option value="local">Local (CLI instalado no sistema)</option>
          </select>
          <small>
            {connectionMode === "account" && "O provider autentica por conta (ex: claude login, antigravity, GitHub Copilot)."}
            {connectionMode === "api_key" && "O provider lê a chave de uma variável de ambiente (ex: ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY). Certifique-se de que a chave está no .env."}
            {connectionMode === "local" && "Provider local/CLI próprio (ex: ollama, model local)."}
          </small>
        </label>

        <label className="field">
          <span>Label</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Ex: DeepSeek (API)" />
        </label>
        <label className="field">
          <span>Comando do provider (CLI)</span>
          <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="Ex: claude, codex, opencode, ollama, node meu-provider.js" />
        </label>
        <label className="field">
          <span>Argumentos (ex: -m modelo) — opcional</span>
          <input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="Ex: -m opencode/deepseek-v4-flash" />
        </label>
        <label className="field">
          <span>Modelo (opcional)</span>
          <input value={model} onChange={(event) => setModel(event.target.value)} placeholder={currentPreset?.models?.[0] ?? "Ex: claude-sonnet-4-6, gpt-4o, deepseek-chat"} />
        </label>

        <div className="prov-connect-actions">
          <button type="button" className="btn-new" disabled={connState !== "idle" || !command.trim()} onClick={() => void test()}>
            {connState === "testing" ? "Testando conexão..." : "Testar conexão"}
          </button>
          <button type="button" className="btn-new primary" disabled={connState !== "idle" || !command.trim()} onClick={() => void save()}>
            {connState === "saving" ? "Registrando..." : "Registrar provider"}
          </button>
        </div>
        {connDetail ? <p className="provider-conn-detail">{connDetail}</p> : null}
      </div>

      {registered.length > 0 ? (
        <div className="registered-list">
          <strong>Providers custom registrados</strong>
          {registered.map((p) => (
            <div className="registered-item" key={p.id}>
              <div><b>{p.label}</b><code>{p.command} {p.args?.join(" ") ?? ""}</code>{p.model ? <small>modelo: {p.model}</small> : null}</div>
              <button type="button" className="btn-ghost danger" onClick={() => void remove(p.id)}>Remover</button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function sanitizeId(value: string): string {
  const cleaned = value.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "custom";
  return cleaned;
}
