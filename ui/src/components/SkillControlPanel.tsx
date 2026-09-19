import { useState } from "react";
import {
  applySkillCurator,
  DashboardData,
  fetchSkillCuratorCandidates,
  fetchSkillCuratorReport,
  fetchSkillProposals,
  processSkillCuratorCandidates,
  reconcileSkillProposals,
  updateSkillRuntimeEnabled
} from "../api";
import { SectionHeader } from "./SectionHeader";
import { translate } from "../i18n";

export function SkillControlPanel({ data, onRefresh }: { data: DashboardData; onRefresh: () => Promise<unknown> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function runAction(name: string, action: () => Promise<unknown>, message: string) {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      await onRefresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : translate("Unable to update skills."));
    } finally {
      setBusy(null);
    }
  }

  const settings = data.skillSettings;
  const report = data.skillCuratorReport;
  const activeSkills = data.skills.filter((skill) => skill.activeVersionId);

  return (
    <section className="panel skills-panel" aria-labelledby="skills-title">
      <SectionHeader
        eyebrow={translate("Judgment rules")}
        title={translate("Skills")}
        meta={`${activeSkills.length} ${translate("active")}`}
      />
      <div className="skills-panel-body">
        <div className="skills-runtime-row">
          <div className="skills-runtime-copy">
            <strong>{translate("Use skills during task execution")}</strong>
            <small>
              {translate("Skills guide judgment and evidence. They never bypass approval, write scopes, or explicit invocation rules.")}
            </small>
          </div>
          <button
            type="button"
            className={`skill-toggle ${settings.enabled ? "is-enabled" : ""}`}
            onClick={() => void runAction(
              "toggle",
              () => updateSkillRuntimeEnabled(!settings.enabled),
              settings.enabled ? translate("Skills disabled.") : translate("Skills enabled.")
            )}
            disabled={busy !== null}
          >
            <span className="skill-toggle-dot" aria-hidden="true" />
            {busy === "toggle" ? translate("Updating") : settings.enabled ? translate("Skills enabled") : translate("Enable skills")}
          </button>
        </div>

        <div className="skills-catalog" aria-live="polite">
          {data.skills.length === 0 ? (
            <div className="skills-empty">
              <span className="skills-empty-mark" aria-hidden="true">∅</span>
              <div>
                <strong>{translate("No registered skills")}</strong>
                <small>{translate("Built-in skills will appear here after the application loads its catalog.")}</small>
              </div>
            </div>
          ) : data.skills.map((skill) => (
            <article key={skill.qualifiedName} className={`skill-card ${skill.activeVersionId ? "is-active" : "is-inactive"}`}>
              <div className="skill-card-head">
                <span className="skill-card-icon" aria-hidden="true">✦</span>
                <span className="skill-card-status">{skill.activeVersionId ? translate("Active") : translate("Not active")}</span>
              </div>
              <strong className="skill-card-name">{skill.qualifiedName}</strong>
              <small className="skill-card-description">{skill.description}</small>
              {skill.evaluation ? <span className="skill-card-evaluation">{translate("Evaluation")}: {skill.evaluation.status}</span> : null}
            </article>
          ))}
        </div>

        <div className="skills-curator">
          <div className="skills-curator-head">
            <div>
              <span className="skills-sub-eyebrow">{translate("Lifecycle")}</span>
              <strong>{translate("Curator")}</strong>
            </div>
            <span className={`skills-curator-mode ${settings.curatorAutomaticArchivalEnabled ? "is-automatic" : "is-dry-run"}`}>
              {settings.curatorAutomaticArchivalEnabled ? translate("Automatic archival enabled") : translate("Dry run — no automatic archival")}
            </span>
          </div>
          <small className="skills-curator-help">
            {translate("The curator gate is visible here. Review its report before applying any archival action.")}
          </small>
          <div className="skills-actions">
            <button className="skill-action" type="button" onClick={() => void runAction("report", fetchSkillCuratorReport, translate("Curator report refreshed."))} disabled={busy !== null}>
              {busy === "report" ? "..." : translate("Refresh report")}
            </button>
            <button className="skill-action" type="button" onClick={() => void runAction("proposals", fetchSkillProposals, translate("Proposals refreshed."))} disabled={busy !== null}>
              {busy === "proposals" ? "..." : translate("Refresh proposals")}
            </button>
            <button className="skill-action" type="button" onClick={() => void runAction("reconcile", reconcileSkillProposals, translate("Skill proposals reconciled."))} disabled={busy !== null}>
              {busy === "reconcile" ? "..." : translate("Reconcile proposals")}
            </button>
            <button className="skill-action" type="button" onClick={() => void runAction("candidates", fetchSkillCuratorCandidates, translate("Curator candidates refreshed."))} disabled={busy !== null}>
              {busy === "candidates" ? "..." : translate("Refresh candidates")}
            </button>
            <button className="skill-action" type="button" onClick={() => void runAction("process", processSkillCuratorCandidates, translate("Curator incidents processed."))} disabled={busy !== null}>
              {busy === "process" ? "..." : translate("Process incidents")}
            </button>
            <button
              type="button"
              className="skill-action skill-action-primary"
              onClick={() => void runAction("apply", applySkillCurator, translate("Curator action applied."))}
              disabled={busy !== null || !settings.curatorAutomaticArchivalEnabled}
              title={settings.curatorAutomaticArchivalEnabled ? undefined : translate("Automatic archival is disabled; this remains a dry run.")}
            >
              {busy === "apply" ? "..." : translate("Apply curator")}
            </button>
          </div>
          <small className="skills-curator-count">
            {report.entries.length} {translate("skills in report")} · {report.candidates.length} {translate("candidates")}
          </small>
        </div>

        {notice ? <p className="skills-feedback is-success" role="status">{notice}</p> : null}
        {error ? <p className="skills-feedback is-error" role="alert">{error}</p> : null}
      </div>
    </section>
  );
}
