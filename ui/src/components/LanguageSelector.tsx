import { getLocaleLabel, isLocale, SUPPORTED_LOCALES, translate, useI18n } from "../i18n";

export function LanguageSelector() {
  const { locale, setLocale } = useI18n();
  return (
    <div className="language-setting">
      <span className="language-setting-label">{translate("Language")}</span>
      <div className="language-options" role="radiogroup" aria-label={translate("Language")}>
        {SUPPORTED_LOCALES.map((supportedLocale) => (
          <button
            type="button"
            className={`language-option${locale === supportedLocale.id ? " is-active" : ""}`}
            key={supportedLocale.id}
            role="radio"
            aria-checked={locale === supportedLocale.id}
            onClick={() => {
              if (isLocale(supportedLocale.id)) setLocale(supportedLocale.id);
            }}
          >
            <span className="language-option-code" aria-hidden="true">{supportedLocale.id === "en" ? "EN" : "PT"}</span>
            <span className="language-option-copy">
              <strong>{translate(getLocaleLabel(supportedLocale.id))}</strong>
              <small>{translate(supportedLocale.id === "en" ? "Use English throughout the dashboard." : "Use Brazilian Portuguese throughout the dashboard.")}</small>
            </span>
            <span className="language-option-mark" aria-hidden="true">{locale === supportedLocale.id ? "✓" : ""}</span>
          </button>
        ))}
      </div>
      <small className="language-setting-help">{translate("Choose the language used by the Maestro dashboard. The default is English.")}</small>
    </div>
  );
}
