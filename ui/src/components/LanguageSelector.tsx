import { translate, useI18n } from "../i18n";

export function LanguageSelector() {
  const { locale, setLocale } = useI18n();
  return (
    <div className="language-setting" style={{ display: "grid", gap: "8px" }}>
      <label htmlFor="maestro-language" style={{ fontWeight: 600 }}>{translate("Language")}</label>
      <select
        id="maestro-language"
        value={locale}
        onChange={(event) => setLocale(event.target.value === "pt-BR" ? "pt-BR" : "en")}
        style={{ maxWidth: "280px" }}
      >
        <option value="en">{translate("English")}</option>
        <option value="pt-BR">{translate("Brazilian Portuguese")}</option>
      </select>
      <small style={{ color: "var(--text-2)" }}>{translate("Choose the language used by the Maestro dashboard. The default is English.")}</small>
    </div>
  );
}
