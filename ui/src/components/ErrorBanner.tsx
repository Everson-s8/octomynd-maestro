import { Icon } from "./Icon";

export function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <Icon name="warning" />
      <span>{message}</span>
      <button onClick={onRetry}>Tentar novamente</button>
    </div>
  );
}
