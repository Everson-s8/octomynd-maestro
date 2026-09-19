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
    <section className="panel" aria-labelledby="skills-title" style={{ padding: "20px" }}>
      <SectionHeader
        eyebrow={translate("Judgment rules")}
        title={translate("Skills")}
        meta={`${activeSkills.length} ${translate("active")}`}
      />
      <div style={{ display: "grid", gap: "16px", marginTop: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
          <div>
            <strong style={{ display: "block", color: "#fff" }}>{translate("Use skills during task execution")}</strong>
            <small style={{ color: "var(--text-2)" }}>
              {translate("Skills guide judgment and evidence. They never bypass approval, write scopes, or explicit invocation rules.")}
            </small>
          </div>
          <button
            type="button"
            onClick={() => void runAction(
              "toggle",
              () => updateSkillRuntimeEnabled(!settings.enabled),
              settings.enabled ? translate("Skills disabled.") : translate("Skills enabled.")
            )}
            disabled={busy !== null}
          >
            {busy === "toggle" ? "..." : settings.enabled ? translate("Disable skills") : translate("Enable skills")}
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "10px" }}>
          {data.skills.length === 0 ? (
            <small style={{ color: "var(--text-2)" }}>{translate("No registered skills.")}</small>
          ) : data.skills.map((skill) => (
            <div key={skill.qualifiedName} style={{ padding: "12px", border: "1px solid #2e323e", borderRadius: "8px", background: "rgba(255,255,255,0.02)" }}>
              <strong style={{ display: "block", color: "#fff" }}>{skill.qualifiedName}</strong>
              <small style={{ display: "block", color: "var(--text-2)", marginTop: "4px" }}>{skill.description}</small>
              <small style={{ display: "block", marginTop: "8px", color: skill.activeVersionId ? "#86c98b" : "#d89d72" }}>
                {skill.activeVersionId ? translate("Active") : translate("Not active")}
                {skill.evaluation ? ` · ${skill.evaluation.status}` : ""}
              </small>
            </div>
          ))}
        </div>

        <div style={{ padding: "14px", border: "1px solid #2e323e", borderRadius: "8px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
            <strong style={{ color: "#fff" }}>{translate("Curator")}</strong>
            <span style={{ color: settings.curatorAutomaticArchivalEnabled ? "#d89d72" : "#86c98b" }}>
              {settings.curatorAutomaticArchivalEnabled ? translate("Automatic archival enabled") : translate("Dry run — no automatic archival")}
            </span>
          </div>
          <small style={{ display: "block", color: "var(--text-2)", marginTop: "6px" }}>
            {translate("The curator gate is visible here. Review its report before applying any archival action.")}
          </small>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "12px" }}>
            <button type="button" onClick={() => void runAction("report", fetchSkillCuratorReport, translate("Curator report refreshed."))} disabled={busy !== null}>
              {busy === "report" ? "..." : translate("Refresh report")}
            </button>
            <button type="button" onClick={() => void runAction("proposals", fetchSkillProposals, translate("Proposals refreshed."))} disabled={busy !== null}>
              {busy === "proposals" ? "..." : translate("Refresh proposals")}
            </button>
            <button type="button" onClick={() => void runAction("reconcile", reconcileSkillProposals, translate("Skill proposals reconciled."))} disabled={busy !== null}>
              {busy === "reconcile" ? "..." : translate("Reconcile proposals")}
            </button>
            <button type="button" onClick={() => void runAction("candidates", fetchSkillCuratorCandidates, translate("Curator candidates refreshed."))} disabled={busy !== null}>
              {busy === "candidates" ? "..." : translate("Refresh candidates")}
            </button>
            <button type="button" onClick={() => void runAction("process", processSkillCuratorCandidates, translate("Curator incidents processed."))} disabled={busy !== null}>
              {busy === "process" ? "..." : translate("Process incidents")}
            </button>
            <button
              type="button"
              onClick={() => void runAction("apply", applySkillCurator, translate("Curator action applied."))}
              disabled={busy !== null || !settings.curatorAutomaticArchivalEnabled}
              title={settings.curatorAutomaticArchivalEnabled ? undefined : translate("Automatic archival is disabled; this remains a dry run.")}
            >
              {busy === "apply" ? "..." : translate("Apply curator")}
            </button>
          </div>
          <small style={{ display: "block", color: "var(--text-2)", marginTop: "10px" }}>
            {report.entries.length} {translate("skills in report")} · {report.candidates.length} {translate("candidates")}
          </small>
        </div>

        {notice ? <p style={{ color: "#86c98b", margin: 0 }}>{notice}</p> : null}
        {error ? <p style={{ color: "#e8967a", margin: 0 }}>{error}</p> : null}
      </div>
    </section>
  );
}
