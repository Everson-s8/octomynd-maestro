import { DashboardProject } from "../api";
import { Icon } from "./Icon";
import { SectionHeader } from "./SectionHeader";

export function ProjectDeck({ projects }: { projects: DashboardProject[] }) {
  return (
    <section className="panel project-deck" id="projects" aria-labelledby="projects-title">
      <SectionHeader eyebrow="Workspace" title="Projetos locais" meta={`${projects.length} registrados`} />
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
                <strong>{project.activeTaskCount}</strong> ativas
              </span>
              <span>
                <strong>{project.taskCount}</strong> total
              </span>
              <span>
                <strong>{project.defaultBranch}</strong> branch
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
                <span>Nenhum agente trabalhando agora</span>
              )}
            </div>
            <small className="project-path">Repositório local protegido</small>
          </article>
        ))}
      </div>
    </section>
  );
}
