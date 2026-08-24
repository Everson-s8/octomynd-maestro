import { TaskStatus, FeatureStatus } from "../api";
import { taskStatusLabel, featureStatusLabels } from "../helpers";

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`status-pill status-${status}`}>{taskStatusLabel(status)}</span>;
}

export function FeatureStatusBadge({ status }: { status: FeatureStatus }) {
  return <span className={`status-pill status-${status}`}>{featureStatusLabels[status] ?? status}</span>;
}

export function StatusPill({ status }: { status: TaskStatus }) {
  return <StatusBadge status={status} />;
}

export function FeatureStatusPill({ status }: { status: FeatureStatus }) {
  return <FeatureStatusBadge status={status} />;
}
