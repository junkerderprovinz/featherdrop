"use client";

import Link from "next/link";
import { Button, Center, Stack, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Logo } from "@/components/Logo";

export default function NotFound() {
  const { t } = useTranslation();
  return (
    <Center style={{ minHeight: "100vh" }} p="md">
      <Stack align="center" gap="md">
        <Logo size={40} />
        <Title order={2}>{t("notfound.title")}</Title>
        <Text c="dimmed" ta="center" maw={360}>
          {t("notfound.body")}
        </Text>
        <Button component={Link} href="/" variant="light">
          {t("notfound.share")}
        </Button>
      </Stack>
    </Center>
  );
}
