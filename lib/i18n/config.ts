// The client's i18next instance, initialized once with every locale. The
// caller passes the language it detected.
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LANGUAGE, resources } from "./locales/index";

// i18next wants { <lng>: { <ns>: { <key>: value } } }.
const i18nResources = Object.fromEntries(
  Object.entries(resources).map(([code, dict]) => [code, { translation: dict }]),
);

let initialized = false;

export function initI18n(lng: string = DEFAULT_LANGUAGE): typeof i18next {
  if (!initialized) {
    void i18next.use(initReactI18next).init({
      resources: i18nResources,
      lng,
      fallbackLng: DEFAULT_LANGUAGE,
      interpolation: { escapeValue: false }, // React already escapes
      returnNull: false,
    });
    initialized = true;
  } else if (i18next.language !== lng) {
    void i18next.changeLanguage(lng);
  }
  return i18next;
}
