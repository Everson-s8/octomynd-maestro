import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DashboardData } from "../api";
import { getRecommendedLocale, Locale, translate, translateCount, useI18n } from "../i18n";

export const ONBOARDING_STEP_KEY = "maestro:onboarding-step";
export const ONBOARDING_COMPLETED_KEY = "maestro:onboarding-completed";
export const ONBOARDING_STEPS = ["language", "product", "provider", "project", "first-action"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingState {
  step: OnboardingStep;
  completed: boolean;
}

export function readOnboardingState(): OnboardingState {
  try {
    const stored = window.localStorage.getItem(ONBOARDING_STEP_KEY);
    return {
      step: ONBOARDING_STEPS.includes(stored as OnboardingStep) ? stored as OnboardingStep : "language",
      completed: window.localStorage.getItem(ONBOARDING_COMPLETED_KEY) === "true"
    };
  } catch {
    return { step: "language", completed: false };
  }
}

function readStep(): OnboardingStep {
  return readOnboardingState().step;
}

function persistStep(step: OnboardingStep): void {
  try {
    window.localStorage.setItem(ONBOARDING_STEP_KEY, step);
  } catch {
    // The session can continue even when browser storage is unavailable.
  }
}

function isCompleted(): boolean {
  return readOnboardingState().completed;
}

function completeOnboarding(): void {
  try {
    window.localStorage.setItem(ONBOARDING_COMPLETED_KEY, "true");
  } catch {
    // Completion remains valid for the current session.
  }
}

export function resetOnboarding(): void {
  try {
    window.localStorage.removeItem(ONBOARDING_COMPLETED_KEY);
    window.localStorage.setItem(ONBOARDING_STEP_KEY, "language");
  } catch {
    // The settings action still reloads the component for the current session.
  }
}

export function FirstRunOnboarding({
  data,
  onCreate,
  onRegisterProject
}: {
  data: DashboardData;
  onCreate: () => void;
  onRegisterProject?: () => void;
}) {
  const navigate = useNavigate();
  const { locale, setLocale } = useI18n();
  const [step, setStep] = useState<OnboardingStep>(() => readStep());
  const [completed, setCompleted] = useState(() => isCompleted());
  const recommendedLocale = useMemo(() => getRecommendedLocale(), []);
  const readyProviders = data.agents.filter(
    (agent) => agent.id !== "telegram" && (agent.state === "ready" || agent.state === "working")
  );

  useEffect(() => {
    if (step === "project" && data.projects.length > 0) {
      persistStep("first-action");
      setStep("first-action");
    }
  }, [data.projects.length, step]);

  if (completed) return null;

  const advance = (next: OnboardingStep) => {
    persistStep(next);
    setStep(next);
  };

  const finish = () => {
    completeOnboarding();
    setCompleted(true);
  };

  const chooseLocale = (next: Locale) => {
    setLocale(next);
    advance("product");
  };

  return (
    <section className="first-run-card" aria-labelledby="first-run-title">
      <div className="first-run-topline">
        <span className="eyebrow">{translate("First run")}</span>
        <button type="button" className="first-run-skip" onClick={finish}>
          {translate("Skip for now")}
        </button>
      </div>
      <div className="first-run-progress" aria-label={translate("Onboarding progress")}>
        {ONBOARDING_STEPS.map((item) => <span key={item} className={item === step ? "is-current" : ONBOARDING_STEPS.indexOf(item) < ONBOARDING_STEPS.indexOf(step) ? "is-done" : ""} />)}
      </div>

      {step === "language" ? (
        <div className="first-run-content">
          <h2 id="first-run-title">{translate("Welcome to Maestro")}</h2>
          <p>{translate("Choose the language for the Maestro interface. This does not limit the language you can use in Chat or tasks.")}</p>
          {recommendedLocale === "pt-BR" && locale === "en" ? <p className="first-run-note">{translate("Your browser appears to use Portuguese.")}</p> : null}
          <div className="first-run-actions">
            <button type="button" className="btn-new" onClick={() => chooseLocale("pt-BR")}>{translate("Português (Brasil)")}</button>
            <button type="button" className="btn-ghost" onClick={() => chooseLocale("en")}>{translate("English")}</button>
          </div>
        </div>
      ) : null}

      {step === "product" ? (
        <div className="first-run-content">
          <h2 id="first-run-title">{translate("A clear path from idea to working software")}</h2>
          <p>{translate("Maestro connects the AI service you already use to your project. It helps you understand the work, execute it in an isolated workspace, and keeps you in control of the final decision.")}</p>
          <div className="first-run-actions">
            <button type="button" className="btn-new" onClick={() => advance("provider")}>{translate("Continue")}</button>
            <button type="button" className="btn-ghost" onClick={finish}>{translate("I know what I need")}</button>
          </div>
        </div>
      ) : null}

      {step === "provider" ? (
        <div className="first-run-content">
          <h2 id="first-run-title">{translate("Connect an AI provider")}</h2>
          <p>{translate("Choose a provider you already use. Maestro will show whether it is installed, authenticated, and ready before you start work.")}</p>
          <div className={`first-run-status ${readyProviders.length ? "is-ready" : ""}`} role="status">
            {readyProviders.length
              ? translateCount(readyProviders.length, "1 provider ready to use", "{count} providers ready to use")
              : translate("No provider is ready yet")}
          </div>
          <div className="first-run-actions">
            <button type="button" className="btn-new" onClick={() => navigate("/providers")}>{translate("Open provider setup")}</button>
            {readyProviders.length ? <button type="button" className="btn-ghost" onClick={() => advance("project")}>{translate("Continue")}</button> : null}
            <button type="button" className="btn-link" onClick={finish}>{translate("I’ll configure this later")}</button>
          </div>
        </div>
      ) : null}

      {step === "project" ? (
        <div className="first-run-content">
          <h2 id="first-run-title">{translate("Choose where you want to work")}</h2>
          <p>{translate("A project is the repository Maestro will work on. You can import one from GitHub, connect a local repository, or use Chat about Maestro without a project.")}</p>
          <div className="first-run-actions">
            {onRegisterProject ? <button type="button" className="btn-new" onClick={onRegisterProject}>{translate("Add a project")}</button> : null}
            <button type="button" className="btn-ghost" onClick={() => { navigate("/chat"); finish(); }}>{translate("Open Chat without a project")}</button>
            <button type="button" className="btn-link" onClick={finish}>{translate("I’ll do this later")}</button>
          </div>
        </div>
      ) : null}

      {step === "first-action" ? (
        <div className="first-run-content">
          <h2 id="first-run-title">{translate("You are ready for your first useful interaction")}</h2>
          <p>{translate("Tell Maestro what you want to do in natural language. You can start a task or ask Chat a question first.")}</p>
          <div className="first-run-actions">
            <button type="button" className="btn-new" onClick={() => { finish(); onCreate(); }}>{translate("Create your first task")}</button>
            <button type="button" className="btn-ghost" onClick={() => { navigate("/chat"); finish(); }}>{translate("Open Chat")}</button>
            <button type="button" className="btn-link" onClick={finish}>{translate("Finish setup")}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
