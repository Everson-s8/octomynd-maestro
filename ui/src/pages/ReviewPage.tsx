import { DashboardData } from "../api";
import { HumanReviewQueue } from "../components/HumanReviewQueue";
import { SectionHeader } from "../components/SectionHeader";
import { Icon } from "../components/Icon";
import { translate } from "../i18n";

export interface ReviewPageProps {
  data: DashboardData;
  onRefresh: () => Promise<unknown>;
}

export function ReviewPage({ data, onRefresh }: ReviewPageProps) {
  return (
    <div className="review-page-grid" style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div className="panel review-overview-banner">
        <div>
          <span className="eyebrow">
            {translate("Human governance (Human Gate)")}
          </span>
          <h2>{translate("Pull Request review center")}</h2>
          <p>
            {translate("Review evidence, security checks, and approve or request changes before the final merge.")}
          </p>
        </div>
        <div className="review-overview-count">
          <strong>{data.reviewQueue.length}</strong>
          <span>{translate("Pull requests pending")}</span>
        </div>
      </div>

      <HumanReviewQueue reviews={data.reviewQueue} onChanged={onRefresh} />
    </div>
  );
}
