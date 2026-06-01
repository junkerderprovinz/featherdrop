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
import { theme } from "@/theme";
import { I18nProvider } from "@/components/i18n/I18nProvider";
import { SUPPORTED, DEFAULT_LANGUAGE, isRtl } from "@/lib/i18n/locales";
import { COOKIE, pickLanguage } from "@/lib/i18n/detect";

export const metadata: Metadata = {
  title: "featherdrop",
  description:
    "Drop it like it's hot — your own self-hosted drop zone. Fling a file in, get a link out, watch it self-destruct on schedule. No accounts, no clouds.",
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
      <body>
        <DirectionProvider initialDirection={dir} detectDirection={false}>
          <MantineProvider theme={theme} defaultColorScheme="auto">
            <Notifications position="top-center" />
            <div className="fd-aurora" aria-hidden="true" />
            <div className="fd-content">
              <I18nProvider initialLanguage={lang}>{children}</I18nProvider>
            </div>
          </MantineProvider>
        </DirectionProvider>
      </body>
    </html>
  );
}
