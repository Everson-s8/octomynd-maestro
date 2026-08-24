import { Icon } from "./Icon";
import { translate } from "../i18n";

export function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <Icon name="warning" />
      <span>{message}</span>
      <button onClick={onRetry}>{translate("Retry")}</button>
    </div>
  );
}
