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
      <div className="panel review-overview-banner" style={{ padding: "20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <span className="eyebrow" style={{ color: "#c084fc", fontWeight: 600, fontSize: "12px", textTransform: "uppercase" }}>
            {translate("Human governance (Human Gate)")}
          </span>
          <h2 style={{ fontSize: "24px", margin: "4px 0", color: "#fff" }}>{translate("Pull Request review center")}</h2>
          <p style={{ color: "#a0a5b5", margin: 0, fontSize: "14px" }}>
            {translate("Review evidence, security checks, and approve or request changes before the final merge.")}
          </p>
        </div>
        <div style={{ background: "rgba(192, 132, 252, 0.1)", border: "1px solid rgba(192, 132, 252, 0.3)", borderRadius: "8px", padding: "12px 20px", textAlign: "center" }}>
          <strong style={{ fontSize: "24px", color: "#c084fc", display: "block" }}>{data.reviewQueue.length}</strong>
          <span style={{ fontSize: "12px", color: "#a0a5b5" }}>{translate("Pull requests pending")}</span>
        </div>
      </div>

      <HumanReviewQueue reviews={data.reviewQueue} onChanged={onRefresh} />
    </div>
  );
}
