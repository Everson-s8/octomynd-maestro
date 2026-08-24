import { DashboardProject } from "../api";
import { Icon } from "./Icon";
import { SectionHeader } from "./SectionHeader";
import { translate } from "../i18n";

export function ProjectDeck({ projects }: { projects: DashboardProject[] }) {
  return (
    <section className="panel project-deck" id="projects" aria-labelledby="projects-title">
      <SectionHeader eyebrow="Workspace" title={translate("Local projects")} meta={`${projects.length} ${translate("registered")}`} />
      <div className="project-grid">
        {projects.map((project, index) => (
          <article className={`project-card project-tone-${index % 3}`} key={project.key}>
            <div className="project-icon">
              <Icon name={project.key === "boo" ? "ghost" : "folder"} />
            </div>
            <div className="project-title">
              <span>@{project.key}</span>
              <strong>{project.name}</strong>
            </div>
            <div className="project-stats">
              <span>
                <strong>{project.activeTaskCount}</strong> {translate("active")}
              </span>
              <span>
                <strong>{project.taskCount}</strong> {translate("total")}
              </span>
              <span>
                <strong>{project.defaultBranch}</strong> {translate("branch")}
              </span>
            </div>
            <div className="project-live-status">
              {project.currentWork.length > 0 ? (
                project.currentWork.map((work) => (
                  <span key={`${work.taskId}-${work.phase}`}>
                    {work.provider ?? "Maestro"} · task #{work.taskId} · {work.phase}
                  </span>
                ))
              ) : (
                <span>{translate("No agent working now")}</span>
              )}
            </div>
            <small className="project-path">
              {translate("sync")}: {project.syncState} · {project.canonicalHeadSha ? project.canonicalHeadSha.slice(0, 8) : translate("no commit")}
            </small>
            <small className="project-path">{translate("Protected local repository")}</small>
          </article>
        ))}
      </div>
    </section>
  );
}
