import { getLocaleLabel, isLocale, SUPPORTED_LOCALES, translate, useI18n } from "../i18n";

export function LanguageSelector() {
  const { locale, setLocale } = useI18n();
  return (
    <div className="language-setting" style={{ display: "grid", gap: "8px" }}>
      <label htmlFor="maestro-language" style={{ fontWeight: 600 }}>{translate("Language")}</label>
      <select
        id="maestro-language"
        value={locale}
        onChange={(event) => {
          if (isLocale(event.target.value)) setLocale(event.target.value);
        }}
        style={{ maxWidth: "280px" }}
      >
        {SUPPORTED_LOCALES.map((supportedLocale) => (
          <option value={supportedLocale.id} key={supportedLocale.id}>
            {translate(getLocaleLabel(supportedLocale.id))}
          </option>
        ))}
      </select>
      <small style={{ color: "var(--text-2)" }}>{translate("Choose the language used by the Maestro dashboard. The default is English.")}</small>
    </div>
  );
}
