import "@glimstone/core/tokens.css";
import "@fontsource-variable/noto-sans";
import "@fontsource-variable/noto-sans-arabic";
import "./app.css";
import { wireTooltips } from "@glimstone/core";
import { createApp } from "vue";
import { config, loadConfig } from "@/src/config";
import { installGlyphs } from "@/src/glyphs";
import { installIntake } from "@/src/intake";
import { applyPrefs, keepPrefs } from "@/src/prefs";
import App from "./App.vue";

// The PWA share target needs a controlling worker before a share sheet posts
// to it, so the worker is registered at start and not only on the first
// download. Registering the same script and scope again does nothing.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw-download.js", { scope: "/" }).catch(() => {
    // Plain HTTP or a private window: downloads take the blob path.
  });
}

const serverAccent = () => config.branding.accentColor;
applyPrefs(null);
installGlyphs();
installIntake();
wireTooltips();

void loadConfig().then(() => {
  applyPrefs(serverAccent());
  keepPrefs(serverAccent);
  createApp(App).mount("#root");
});
