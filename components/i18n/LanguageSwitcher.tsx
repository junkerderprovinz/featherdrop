"use client";

import { ActionIcon, Menu, ScrollArea, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { LANGUAGES } from "@/lib/i18n/locales";
import { writeLanguageCookie } from "@/lib/i18n/detect";
import { Flag } from "./Flag";

// The flag-based language picker shown beside the theme toggle. The button shows
// the current language's flag; the menu lists every language. Choosing one
// switches i18next live and persists the choice in a cookie.
export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const current = LANGUAGES.find((l) => l.code === i18n.language) ?? LANGUAGES[0];

  const choose = (code: string) => {
    void i18n.changeLanguage(code);
    writeLanguageCookie(code);
  };

  return (
    <Menu shadow="md" width={200} position="bottom-end" withinPortal>
      <Menu.Target>
        <Tooltip label={t("language.label")} withArrow>
          <ActionIcon variant="default" size="lg" aria-label={t("language.label")}>
            <Flag code={current.flag} size={20} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        <ScrollArea.Autosize mah={320} type="scroll">
          {LANGUAGES.map((lang) => (
            <Menu.Item
              key={lang.code}
              leftSection={<Flag code={lang.flag} size={20} />}
              onClick={() => choose(lang.code)}
              fw={lang.code === current.code ? 700 : 400}
            >
              {lang.label}
            </Menu.Item>
          ))}
        </ScrollArea.Autosize>
      </Menu.Dropdown>
    </Menu>
  );
}
