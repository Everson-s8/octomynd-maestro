import { useState } from "react";
import { cancelFeature, DashboardFeature, FeatureStatus } from "../api";
import { featureProgress, featureStatusLabels, featureStatusOrder } from "../helpers";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { SectionHeader } from "./SectionHeader";
import { FeatureStatusPill } from "./StatusBadge";
import { translate } from "../i18n";

export function FeatureBoard({
  features,
  onChanged
}: {
  features: DashboardFeature[];
  onChanged: () => Promise<unknown>;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sortedFeatures = [...features].sort((left, right) => {
    const statusDelta = featureStatusOrder.indexOf(left.status) - featureStatusOrder.indexOf(right.status);
    if (statusDelta !== 0) return statusDelta;
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  });
  const counts = features.reduce<Record<FeatureStatus, number>>(
    (accumulator, feature) => {
      accumulator[feature.status] += 1;
      return accumulator;
    },
    {
      draft: 0,
      waiting_checks: 0,
      reviewing: 0,
      waiting_provider: 0,
      changes_requested: 0,
      merging: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    }
  );

  async function handleCancel(feature: DashboardFeature) {
    if (
      !window.confirm(
        translate(
          "Cancel Feature #{id} ({name}) before merge? The history and consolidated PR are preserved for audit.",
          { id: feature.id, name: feature.name }
        )
      )
    )
      return;
    setBusyId(feature.id);
    setError(null);
    try {
      await cancelFeature(feature.id, translate("Cancelled from the dashboard."));
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : translate("Unable to cancel the Feature."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="panel feature-board" id="features" aria-labelledby="features-title">
      <SectionHeader eyebrow={translate("Feature PRs")} title={translate("Feature runtime")} meta={`${features.length} ${translate("registered")}`} />
      <div className="feature-status-strip" aria-label={translate("Feature states")}>
        {featureStatusOrder.map((status) => (
          <span className={`feature-status-count status-${status}`} key={status}>
            <strong>{counts[status]}</strong>
            {translate(featureStatusLabels[status])}
          </span>
        ))}
      </div>
      {error ? <p className="detail-error">{error}</p> : null}
      <div className="feature-list">
        {sortedFeatures.length === 0 ? (
          <EmptyState
            icon="folder"
            title={translate("No Feature PR")}
            text={translate("Registered features appear here during checks, final review, and merge.")}
          />
        ) : (
          sortedFeatures.slice(0, 6).map((feature) => (
            <article className={`feature-row status-${feature.status}`} key={feature.id}>
              <span className={`status-rail status-${feature.status}`} />
              <div className="feature-copy">
                <div>
                  <span className="project-tag">@{feature.projectKey}</span>
                  <FeatureStatusPill status={feature.status} />
                </div>
                <strong>{feature.name}</strong>
                <p>{feature.lastError ?? feature.reviewSummary ?? feature.objective}</p>
                <small>
                  {feature.itemCount} {translate("Work PR(s)")} - {feature.branchName}
                </small>
                {feature.status === "cancelled" && feature.cancelReason ? <small>{translate("Cancelled:")} {feature.cancelReason}</small> : null}
              </div>
              <div className="feature-progress" aria-label={`${translate("Status")}: ${translate(featureStatusLabels[feature.status])}`}>
                <span>
                  <i style={{ width: `${featureProgress(feature.status)}%` }} />
                </span>
                <small>{featureProgress(feature.status)}%</small>
              </div>
              <div className="feature-row-actions">
                {feature.cancellable ? (
                  <button
                    className="row-action row-action-danger"
                    aria-label={translate("Cancel Feature {id}", { id: feature.id })}
                    disabled={busyId !== null}
                    onClick={() => void handleCancel(feature)}
                  >
                    {busyId === feature.id ? "..." : translate("Cancel")}
                  </button>
                ) : null}
                <a
                  className="row-action"
                  href={feature.pullRequestUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={translate("Open Feature PR {id}", { id: feature.id })}
                >
                  <Icon name="arrow" />
                </a>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
