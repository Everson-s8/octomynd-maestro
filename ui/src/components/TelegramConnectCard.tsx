import { useState } from "react";
import { connectTelegram, DashboardData } from "../api";
import { Icon } from "./Icon";
import { SectionHeader } from "./SectionHeader";

export function TelegramConnectCard({
  agents,
  onChanged
}: {
  agents: DashboardData["agents"];
  onChanged?: () => Promise<unknown>;
}) {
  const telegramAgent = agents.find((agent) => agent.id === "telegram");
  const isConnected = telegramAgent?.state === "ready";

  const [botToken, setBotToken] = useState("");
  const [allowedUserId, setAllowedUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!botToken.trim()) {
      setError("Cole o HTTP API Token obtido com o @BotFather.");
      return;
    }

    setBusy(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await connectTelegram({
        botToken: botToken.trim(),
        allowedUserId: allowedUserId.trim() || undefined
      });

      setSuccessMsg(
        `Bot Telegram @${res.botInfo?.username ?? "desconhecido"} conectado com sucesso! (${res.allowedUserId ? `Restrito ao User ID ${res.allowedUserId}` : "Irrestrito"})`
      );
      setBotToken("");
      setAllowedUserId("");

      if (onChanged) {
        await onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao conectar Telegram Bot.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel telegram-connect-card" style={{ padding: "20px" }}>
      <SectionHeader
        eyebrow="Integração Telegram"
        title="Conexão do Telegram Bot"
        meta={isConnected ? "Bot Ativo" : "Pendente"}
      />
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "12px", marginBottom: "16px" }}>
        <span className={`sync-dot ${isConnected ? "" : "is-offline"}`} />
        <span style={{ color: "#fff", fontWeight: 600 }}>
          {isConnected
            ? `Telegram Bot Conectado (${telegramAgent?.detail ?? "Ativo"})`
            : "Telegram Bot Desconectado - Configure abaixo para operar sem CLI."}
        </span>
      </div>

      <p style={{ fontSize: "13px", color: "#a0a5b5", marginBottom: "16px", lineHeight: "1.5" }}>
        Não precisa editar arquivos <code>.env</code> manualmente! Cole o token obtido no <strong>@BotFather</strong> e seu User ID numerico (do <strong>@userinfobot</strong>).
      </p>

      {error ? (
        <div style={{ padding: "10px 14px", background: "rgba(255, 77, 77, 0.1)", border: "1px solid #ff4d4d", borderRadius: "6px", color: "#ff8080", fontSize: "13px", marginBottom: "16px" }}>
          {error}
        </div>
      ) : null}

      {successMsg ? (
        <div style={{ padding: "10px 14px", background: "rgba(46, 204, 113, 0.1)", border: "1px solid #2ecc71", borderRadius: "6px", color: "#2ecc71", fontSize: "13px", marginBottom: "16px" }}>
          {successMsg}
        </div>
      ) : null}

      <form onSubmit={(e) => void handleSubmit(e)} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <div>
          <label style={{ display: "block", fontSize: "12px", color: "#a0a5b5", marginBottom: "4px" }}>
            HTTP API Bot Token (@BotFather) *
          </label>
          <input
            type="password"
            placeholder="Ex: 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            disabled={busy}
            style={{
              width: "100%",
              padding: "10px 12px",
              background: "#161922",
              border: "1px solid #2e323e",
              borderRadius: "6px",
              color: "#fff",
              fontSize: "14px"
            }}
          />
        </div>

        <div>
          <label style={{ display: "block", fontSize: "12px", color: "#a0a5b5", marginBottom: "4px" }}>
            Telegram User ID (@userinfobot) - Opcional para restrição de acesso
          </label>
          <input
            type="text"
            placeholder="Ex: 987654321 (deixe em branco para acesso livre)"
            value={allowedUserId}
            onChange={(e) => setAllowedUserId(e.target.value)}
            disabled={busy}
            style={{
              width: "100%",
              padding: "10px 12px",
              background: "#161922",
              border: "1px solid #2e323e",
              borderRadius: "6px",
              color: "#fff",
              fontSize: "14px"
            }}
          />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "6px" }}>
          <button
            type="submit"
            disabled={busy}
            style={{
              padding: "10px 20px",
              background: "#3b82f6",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              fontWeight: 600,
              cursor: busy ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              opacity: busy ? 0.7 : 1
            }}
          >
            <Icon name="pulse" />
            {busy ? "Validando e Conectando..." : isConnected ? "Atualizar Token do Bot" : "Conectar Bot Telegram"}
          </button>
        </div>
      </form>
    </div>
  );
}
