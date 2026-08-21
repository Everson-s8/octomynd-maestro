import { OctoMark } from "./OctoMark";

type LoadingSpinnerProps = {
  label?: string;
  detail?: string;
};

export function LoadingSpinner({
  label = "Acordando o Maestro",
  detail = "Conectando providers · isolando worktrees",
}: LoadingSpinnerProps) {
  return (
    <div className="loading-screen" role="status" aria-live="polite">
      <div className="loading-screen-mascot">
        <OctoMark large />
      </div>
      <span>{label}</span>
      <small>{detail}</small>
      <i aria-hidden="true" />
    </div>
  );
}

export function LoadingScreen() {
  return <LoadingSpinner />;
}
