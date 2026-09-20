"use client";

import { useEffect } from "react";
import { useDirection } from "@mantine/core";
import { I18nextProvider } from "react-i18next";
import { initI18n } from "@/lib/i18n/config";
import { isRtl } from "@/lib/i18n/locales";

// On a language switch <html lang> follows, and Mantine's setDirection updates
// <html dir> and mirrors the components for right-to-left languages.
export function I18nProvider({
  initialLanguage,
  children,
}: {
  initialLanguage: string;
  children: React.ReactNode;
}) {
  const i18n = initI18n(initialLanguage);
  const { setDirection } = useDirection();

  useEffect(() => {
    const apply = (code: string) => {
      document.documentElement.lang = code;
      setDirection(isRtl(code) ? "rtl" : "ltr");
    };
    i18n.on("languageChanged", apply);
    return () => {
      i18n.off("languageChanged", apply);
    };
  }, [i18n, setDirection]);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
