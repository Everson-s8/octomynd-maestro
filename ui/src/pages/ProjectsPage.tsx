import { DashboardData } from "../api";
import { ProjectDeck } from "../components/ProjectDeck";
import { SectionHeader } from "../components/SectionHeader";
import { Icon } from "../components/Icon";
import { translate } from "../i18n";

export interface ProjectsPageProps {
  data: DashboardData;
}

export function ProjectsPage({ data }: ProjectsPageProps) {
  return (
    <div className="projects-page-grid" style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div className="panel projects-health-summary" style={{ padding: "20px" }}>
        <SectionHeader eyebrow={translate("Workspace")} title={translate("Project health")} meta={`${data.projects.length} ${translate("repositories")}`} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px", marginTop: "16px" }}>
          {data.environments.map((env) => (
            <div
              key={env.projectKey}
              style={{
                padding: "16px",
                borderRadius: "8px",
                background: "rgba(255,255,255,0.02)",
                border: `1px solid ${env.status === "ready" ? "rgba(34, 197, 94, 0.3)" : "rgba(239, 68, 68, 0.3)"}`
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <strong style={{ color: "#fff" }}>@{env.projectKey}</strong>
                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    padding: "2px 8px",
                    borderRadius: "12px",
                    background: env.status === "ready" ? "rgba(34, 197, 94, 0.2)" : "rgba(239, 68, 68, 0.2)",
                    color: env.status === "ready" ? "#4ade80" : "#f87171"
                  }}
                >
                  {env.status === "ready" ? translate("ready").toUpperCase() : translate("attention").toUpperCase()}
                </span>
              </div>
              <p style={{ fontSize: "13px", color: "#a0a5b5", margin: 0 }}>
                {env.status === "ready" ? env.summary : env.recommendedAction}
              </p>
            </div>
          ))}
        </div>
      </div>

      <ProjectDeck projects={data.projects} />
    </div>
  );
}
