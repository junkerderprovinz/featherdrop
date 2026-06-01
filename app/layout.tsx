import "@mantine/core/styles.css";
import "@mantine/dropzone/styles.css";
import "@mantine/notifications/styles.css";
import "flag-icons/css/flag-icons.min.css";
import "./globals.css";

import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import {
  ColorSchemeScript,
  DirectionProvider,
  MantineProvider,
  mantineHtmlProps,
} from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { createAppTheme } from "@/theme";
import { BASE_URL, BRANDING } from "@/lib/config";
import { BrandingProvider } from "@/components/BrandingProvider";
import { wordmark } from "./fonts";
import { I18nProvider } from "@/components/i18n/I18nProvider";
import { SUPPORTED, DEFAULT_LANGUAGE, isRtl } from "@/lib/i18n/locales";
import { COOKIE, pickLanguage } from "@/lib/i18n/detect";

// One description, reused for the tab, search results and social cards so they
// never drift apart. Link previews stay deliberately generic — a shared /d/<slug>
// link must never leak the file's name (the download page sets no own metadata,
// so it inherits this), and the OG/Twitter image is served by the file
// convention app/opengraph-image.png.
const DESCRIPTION =
  "Drop it like it's hot — your own self-hosted drop zone. Fling a file in, get a link out, watch it self-destruct on schedule. No accounts, no clouds.";

export const metadata: Metadata = {
  // Absolute base for resolving the social-card image; only meaningful behind a
  // known public URL. Unset BASE_URL → Next falls back to a relative/dev origin.
  metadataBase: BASE_URL ? new URL(BASE_URL) : undefined,
  title: BRANDING.appName,
  description: DESCRIPTION,
  openGraph: {
    title: BRANDING.appName,
    description: DESCRIPTION,
    siteName: BRANDING.appName,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: BRANDING.appName,
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Resolve the UI language on the server so the page renders translated even
  // without JS, and the first client render matches (no hydration mismatch).
  const lang = pickLanguage(
    cookies().get(COOKIE)?.value,
    headers().get("accept-language"),
    SUPPORTED,
    DEFAULT_LANGUAGE,
  );
  const dir = isRtl(lang) ? "rtl" : "ltr";

  return (
    <html lang={lang} dir={dir} {...mantineHtmlProps}>
      <head>
        <ColorSchemeScript defaultColorScheme="auto" />
        <meta
          name="viewport"
          content="minimum-scale=1, initial-scale=1, width=device-width"
        />
      </head>
      <body className={wordmark.variable}>
        <DirectionProvider initialDirection={dir} detectDirection={false}>
          <MantineProvider
            theme={createAppTheme(BRANDING.accentColor)}
            defaultColorScheme="auto"
          >
            <BrandingProvider
              branding={{
                appName: BRANDING.appName,
                logoUrl: BRANDING.logoUrl,
              }}
            >
              <Notifications position="top-center" />
              <div className="fd-aurora" aria-hidden="true" />
              <div className="fd-content">
                <I18nProvider initialLanguage={lang}>{children}</I18nProvider>
              </div>
            </BrandingProvider>
          </MantineProvider>
        </DirectionProvider>
      </body>
    </html>
  );
}
