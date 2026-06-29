// Vite SPA entry point. It replicates the provider tree app/layout.tsx built on
// the server (MantineProvider + ColorSchemeScript + DirectionProvider +
// Notifications + ServerConfigProvider + BrandingProvider + I18nProvider),
// wrapped in a BrowserRouter for client routing. The one difference from the SSR
// layout: runtime config (baseUrl, uploadProtected, branding) is not available
// at build time, so we FETCH GET /api/config first and render a minimal loader
// until it resolves; on failure we fall back to sensible defaults so the app
// still renders. The language is resolved client-side (cookie -> navigator),
// mirroring the server's pickLanguage in app/layout.tsx.

// CSS imports — the SAME set, in the same order, as app/layout.tsx, plus the
// Bitter wordmark font (src/fonts.css supplies the --font-bitter var that
// next/font set via bitter.variable) and the app globals.
import "@mantine/core/styles.css";
import "@mantine/dropzone/styles.css";
import "@mantine/notifications/styles.css";
import "flag-icons/css/flag-icons.min.css";
import "@fontsource/sansation/400.css";
import "@fontsource/sansation/700.css";
import "./fonts.css";
import "@/app/globals.css";

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import {
  Center,
  ColorSchemeScript,
  DirectionProvider,
  Loader,
  MantineProvider,
} from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { createAppTheme } from "@/theme";
import { DEFAULT_BRANDING } from "@/lib/branding";
import { BrandingProvider } from "@/components/BrandingProvider";
import { ServerConfigProvider } from "@/components/ServerConfigProvider";
import { I18nProvider } from "@/components/i18n/I18nProvider";
import { isRtl } from "@/lib/i18n/locales";
import { detectClientLanguage } from "./detect-client";
import { App } from "./App";

// The GET /api/config body (server-go/internal/api/config.go). The branding shape
// matches lib/branding.ts (Branding). Defaults below mirror DEFAULT_BRANDING and
// the open-upload default so a failed/offline /api/config still renders the app.
interface AppConfig {
  baseUrl: string;
  uploadProtected: boolean;
  branding: {
    appName: string;
    logoUrl: string | null;
    accentColor: string;
  };
}

const FALLBACK_CONFIG: AppConfig = {
  baseUrl: "",
  uploadProtected: false,
  branding: {
    appName: DEFAULT_BRANDING.appName,
    logoUrl: DEFAULT_BRANDING.logoUrl,
    accentColor: DEFAULT_BRANDING.accentColor,
  },
};

// Bootstrap: fetch /api/config, then mount the full provider tree. A minimal
// centered loader shows while the request is in flight; any failure falls back
// to FALLBACK_CONFIG so the UI always renders.
function Bootstrap() {
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/config");
        if (!res.ok) throw new Error(`config ${res.status}`);
        const data = (await res.json()) as Partial<AppConfig>;
        if (cancelled) return;
        // Merge over the fallback so a partial/odd payload can't leave a field
        // undefined (e.g. a missing accentColor would break theme creation).
        setConfig({
          baseUrl: data.baseUrl ?? FALLBACK_CONFIG.baseUrl,
          uploadProtected:
            data.uploadProtected ?? FALLBACK_CONFIG.uploadProtected,
          branding: {
            appName:
              data.branding?.appName ?? FALLBACK_CONFIG.branding.appName,
            logoUrl:
              data.branding?.logoUrl ?? FALLBACK_CONFIG.branding.logoUrl,
            accentColor:
              data.branding?.accentColor ??
              FALLBACK_CONFIG.branding.accentColor,
          },
        });
      } catch {
        if (!cancelled) setConfig(FALLBACK_CONFIG);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!config) {
    return (
      <Center style={{ minHeight: "100vh" }}>
        <Loader />
      </Center>
    );
  }

  // Resolve the UI language + direction client-side, the SPA twin of the server
  // pickLanguage()/isRtl() pass in app/layout.tsx.
  const lang = detectClientLanguage();
  const dir = isRtl(lang) ? "rtl" : "ltr";

  // Same provider tree + structure as app/layout.tsx's <body> (minus the <html>/
  // <head>, which the Go-templated index.html shell already provides). The
  // .fd-aurora / .fd-content wrappers and Notifications position match the layout.
  return (
    <DirectionProvider initialDirection={dir} detectDirection={false}>
      <MantineProvider
        theme={createAppTheme(config.branding.accentColor)}
        defaultColorScheme="auto"
      >
        <ServerConfigProvider
          config={{
            baseUrl: config.baseUrl,
            uploadProtected: config.uploadProtected,
          }}
        >
          <BrandingProvider
            branding={{
              appName: config.branding.appName,
              logoUrl: config.branding.logoUrl,
            }}
          >
            <Notifications position="top-center" />
            <div className="fd-aurora" aria-hidden="true" />
            <div className="fd-content">
              <I18nProvider initialLanguage={lang}>
                <App />
              </I18nProvider>
            </div>
          </BrandingProvider>
        </ServerConfigProvider>
      </MantineProvider>
    </DirectionProvider>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

createRoot(rootEl).render(
  <StrictMode>
    {/* ColorSchemeScript sets the data-mantine-color-scheme attribute early,
        matching app/layout.tsx (which renders it in <head>). */}
    <ColorSchemeScript defaultColorScheme="auto" />
    <BrowserRouter>
      <Bootstrap />
    </BrowserRouter>
  </StrictMode>,
);
