import { useState } from "react";
import { connectTelegram, DashboardData } from "../api";
import { Icon } from "./Icon";
import { SectionHeader } from "./SectionHeader";
import { translate } from "../i18n";

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
      setError(translate("Paste the HTTP API token obtained from @BotFather."));
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
        `${translate("Telegram bot @{username} connected successfully!", { username: res.botInfo?.username ?? translate("unknown") })} (${res.allowedUserId ? translate("Restricted to User ID {id}", { id: res.allowedUserId }) : translate("Unrestricted")})`
      );
      setBotToken("");
      setAllowedUserId("");

      if (onChanged) {
        await onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : translate("Unable to connect the Telegram bot."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel telegram-connect-card" style={{ padding: "20px" }}>
      <SectionHeader
        eyebrow={translate("Telegram integration")}
        title={translate("Telegram bot connection")}
        meta={isConnected ? translate("Bot active") : translate("Pending")}
      />
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "12px", marginBottom: "16px" }}>
        <span className={`sync-dot ${isConnected ? "" : "is-offline"}`} />
        <span style={{ color: "#fff", fontWeight: 600 }}>
          {isConnected
            ? `${translate("Telegram bot connected")} (${telegramAgent?.detail ?? translate("Active")})`
            : translate("Telegram bot disconnected — configure it below to operate without the CLI.")}
        </span>
      </div>

      <p style={{ fontSize: "13px", color: "#a0a5b5", marginBottom: "16px", lineHeight: "1.5" }}>
        {translate("You do not need to edit .env files manually. Paste the token from @BotFather and your numeric User ID from @userinfobot.")}
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
            {translate("HTTP API bot token (@BotFather) *")}
          </label>
          <input
            type="password"
            placeholder={translate("Example: 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ")}
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
            {translate("Telegram User ID (@userinfobot) — optional access restriction")}
          </label>
          <input
            type="text"
            placeholder={translate("Example: 987654321 (leave blank for unrestricted access)")}
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
            {busy ? translate("Validating and connecting…") : isConnected ? translate("Update bot token") : translate("Connect Telegram bot")}
          </button>
        </div>
      </form>
    </div>
  );
}
