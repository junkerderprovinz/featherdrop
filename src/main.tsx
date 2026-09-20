// The SPA entry point. The runtime config (base URL, upload gate, branding) is
// only known to the server, so it is fetched from /api/config behind a loader,
// with defaults when that fails.

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

// The body of server-go/internal/api/config.go.
interface AppConfig {
  baseUrl: string;
  uploadProtected: boolean;
  // May be missing from an older server; "" means no preference or cap.
  defaultExpiry: string;
  maxExpiry: string;
  branding: {
    appName: string;
    logoUrl: string | null;
    accentColor: string;
  };
}

const FALLBACK_CONFIG: AppConfig = {
  baseUrl: "",
  uploadProtected: false,
  defaultExpiry: "",
  maxExpiry: "",
  branding: {
    appName: DEFAULT_BRANDING.appName,
    logoUrl: DEFAULT_BRANDING.logoUrl,
    accentColor: DEFAULT_BRANDING.accentColor,
  },
};

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
        // A missing field, such as accentColor, would break theme creation.
        setConfig({
          baseUrl: data.baseUrl ?? FALLBACK_CONFIG.baseUrl,
          uploadProtected:
            data.uploadProtected ?? FALLBACK_CONFIG.uploadProtected,
          defaultExpiry: data.defaultExpiry ?? FALLBACK_CONFIG.defaultExpiry,
          maxExpiry: data.maxExpiry ?? FALLBACK_CONFIG.maxExpiry,
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

  // The language does not depend on /api/config, so the loader has it too.
  const lang = detectClientLanguage();
  const dir = isRtl(lang) ? "rtl" : "ltr";

  // The accent arrives with /api/config; the default lets MantineProvider mount
  // before that.
  const accentColor =
    config?.branding.accentColor ?? FALLBACK_CONFIG.branding.accentColor;

  // The loader is a Mantine component and throws outside MantineProvider, so
  // the providers wrap the loading state as well and only their content
  // switches on config.
  return (
    <DirectionProvider initialDirection={dir} detectDirection={false}>
      <MantineProvider
        theme={createAppTheme(accentColor)}
        defaultColorScheme="auto"
      >
        {!config ? (
          <Center style={{ minHeight: "100vh" }}>
            <Loader />
          </Center>
        ) : (
          <ServerConfigProvider
            config={{
              baseUrl: config.baseUrl,
              uploadProtected: config.uploadProtected,
              defaultExpiry: config.defaultExpiry,
              maxExpiry: config.maxExpiry,
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
        )}
      </MantineProvider>
    </DirectionProvider>
  );
}

// The PWA share target needs a controlling worker before a share-sheet POST
// arrives, so the worker is registered at boot and not only on the first
// download. Registering the same script and scope again is a no-op.
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("/sw-download.js", { scope: "/" })
    .catch(() => {
      // Insecure context or private mode: downloads use the blob fallback.
    });
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

createRoot(rootEl).render(
  <StrictMode>
    {/* Sets data-mantine-color-scheme before the first paint. */}
    <ColorSchemeScript defaultColorScheme="auto" />
    <BrowserRouter>
      <Bootstrap />
    </BrowserRouter>
  </StrictMode>,
);
