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
      <div className="telegram-status-row">
        <span className={`sync-dot ${isConnected ? "" : "is-offline"}`} />
        <span className="telegram-status-copy">
          {isConnected
            ? `${translate("Telegram bot connected")} (${telegramAgent?.detail ?? translate("Active")})`
            : translate("Telegram bot disconnected — configure it below to operate without the CLI.")}
        </span>
      </div>

      <p className="telegram-help-copy">
        {translate("You do not need to edit .env files manually. Paste the token from @BotFather and your numeric User ID from @userinfobot.")}
      </p>

      {error ? (
        <div className="telegram-feedback is-error">
          {error}
        </div>
      ) : null}

      {successMsg ? (
        <div className="telegram-feedback is-success">
          {successMsg}
        </div>
      ) : null}

      <form onSubmit={(e) => void handleSubmit(e)} className="telegram-connect-form">
        <div>
          <label className="telegram-field-label">
            {translate("HTTP API bot token (@BotFather) *")}
          </label>
          <input
            type="password"
            placeholder={translate("Example: 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ")}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            disabled={busy}
            className="telegram-field"
          />
        </div>

        <div>
          <label className="telegram-field-label">
            {translate("Telegram User ID (@userinfobot) — optional access restriction")}
          </label>
          <input
            type="text"
            placeholder={translate("Example: 987654321 (leave blank for unrestricted access)")}
            value={allowedUserId}
            onChange={(e) => setAllowedUserId(e.target.value)}
            disabled={busy}
            className="telegram-field"
          />
        </div>

        <div className="telegram-submit-row">
          <button
            type="submit"
            disabled={busy}
            className="telegram-submit"
          >
            <Icon name="pulse" />
            {busy ? translate("Validating and connecting…") : isConnected ? translate("Update bot token") : translate("Connect Telegram bot")}
          </button>
        </div>
      </form>
    </div>
  );
}
