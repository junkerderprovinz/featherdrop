// Settings per browser, applied to the document as they change so every
// engine of GlimStone follows. The language lives in its own cookie (see
// ./i18n.ts) and the last upload choices in lib/prefs.ts.
import {
  applyAccent,
  applyMotion,
  applyOled,
  applyRainbow,
  applyShape,
  DEFAULT_ACCENT,
  labelModeChanged,
  setLabelMode,
  storedOled,
  type LabelMode,
} from "@glimstone/core";
import { reactive, watch } from "vue";

const KEY = "castleparcel-prefs";
// The theme a returning visitor picked in the earlier client.
const OLD_THEME_KEY = "mantine-color-scheme-value";

export type Theme = "dark" | "light" | "system";

const DEFAULTS = {
  theme: "system" as Theme,
  oled: storedOled(),
  accent: DEFAULT_ACCENT,
  shape: "round",
  motion: "subtle",
  labelsButtons: "textGlyph" as LabelMode,
  rainbow: false,
  reactive: false,
  remember: true,
  /** "" leaves the default to the server. */
  defaultExpiry: "",
  stripMetadata: true,
  paste: true,
  quiet: false,
  celebrate: true,
};
export type Prefs = typeof DEFAULTS;

function stored(): Partial<Prefs> {
  try {
    const own = localStorage.getItem(KEY);
    if (own) return JSON.parse(own);
    const old = localStorage.getItem(OLD_THEME_KEY);
    return old === "dark" || old === "light" ? { theme: old } : {};
  } catch {
    return {};
  }
}

export const prefs = reactive<Prefs>({ ...DEFAULTS, ...stored() });

/** The accent the page wears: the visitor's own, else the server's ACCENT_COLOR, else GlimStone's. */
export const accentOf = (serverAccent: string | null) =>
  serverAccent && prefs.accent === DEFAULT_ACCENT ? serverAccent : prefs.accent;

export function applyPrefs(serverAccent: string | null) {
  const root = document.documentElement;
  // Without a theme of its own the page is left to GlimStone's stylesheet, which follows the system as it changes.
  if (prefs.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = prefs.theme;
  applyOled(prefs.oled);
  applyAccent(accentOf(serverAccent));
  applyShape(prefs.shape);
  applyMotion(prefs.motion);
  setLabelMode("buttons", prefs.labelsButtons);
  setLabelMode("tabs", prefs.labelsButtons);
  labelModeChanged();
  applyRainbow({ on: prefs.rainbow, reactive: prefs.reactive });
  root.toggleAttribute("data-reactive", prefs.rainbow && prefs.reactive);
}

export function keepPrefs(serverAccent: () => string | null) {
  watch(
    prefs,
    () => {
      try {
        localStorage.setItem(KEY, JSON.stringify(prefs));
      } catch {
        // A private window keeps the choice for this visit.
      }
      applyPrefs(serverAccent());
    },
    { deep: true },
  );
}
