import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./styles-v2.css";
import { applyLocaleMetadata, getLocale, LanguageProvider } from "./i18n";

// Set language metadata before React paints so assistive technologies and
// browser language behavior see the correct locale on the initial render.
applyLocaleMetadata(getLocale());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </StrictMode>
);
