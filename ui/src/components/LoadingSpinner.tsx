import { OctoMark } from "./OctoMark";

export function LoadingSpinner({ label = "acordando o maestro" }: { label?: string }) {
  return (
    <div className="loading-screen">
      <OctoMark large />
      <span>{label}</span>
      <i />
    </div>
  );
}

export function LoadingScreen() {
  return <LoadingSpinner />;
}
