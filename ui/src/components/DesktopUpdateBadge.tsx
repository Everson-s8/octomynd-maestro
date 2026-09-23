import { translate } from "../i18n";
import type { DesktopUpdateStatus } from "../external-links";

type DesktopUpdateBadgeProps = {
  version: string;
  status: DesktopUpdateStatus | null;
  onInstall: () => void;
};

export function DesktopUpdateBadge({ version, status, onInstall }: DesktopUpdateBadgeProps) {
  return <div className="maestro-runtime-badge" role="status">
    <span>{translate("Maestro")} v{version}</span>
    {status?.event === "checking" ? (
      <span>{translate("Checking for updates…")}</span>
    ) : status?.event === "up_to_date" ? (
      <span>{translate("You're up to date.")}</span>
    ) : null}
    {status?.event === "downloading" || status?.event === "progress" ? (
      <span>{translate("Downloading update")} {status.version ? `v${status.version}` : ""} · {status.percent ?? 0}%</span>
    ) : status?.event === "ready" ? (
      <button type="button" onClick={onInstall}>
        {translate("Restart to update")} {status.version ? `v${status.version}` : ""}
      </button>
    ) : null}
  </div>;
}
