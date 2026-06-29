"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ActionIcon,
  Box,
  Button,
  Center,
  Container,
  Group,
  Paper,
  Stack,
  Text,
  Title,
  Tooltip,
  rem,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCheck,
  IconMoon,
  IconSun,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { formatBytes, describeExpiry } from "@/lib/format";
import { Logo } from "@/components/Logo";
import { useBranding } from "@/components/BrandingProvider";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";

// Header the DELETE/GET requests carry the raw manage token in. Kept in sync
// with app/api/m/[slug]/route.ts (duplicated here so this client module has no
// server-only import). The token is read from the URL #fragment and sent in
// THIS header — never in the request path — so it stays out of access logs.
const MANAGE_TOKEN_HEADER = "x-fd-manage-token";

interface ManageViewProps {
  slug: string;
}

// Share status returned by the token-gated GET on /api/m/[slug].
interface ManageStatus {
  size: number;
  expiresAt: number | null;
  downloadsLeft: number | null;
}

type Phase =
  | "loading" // reading the fragment + fetching status
  | "ready" // status known, delete offered
  | "notfound" // no token, or the share is unknown/expired/legacy/deleted
  | "deleting"
  | "deleted"; // successful delete

export function ManageView({ slug }: ManageViewProps) {
  const { t } = useTranslation();
  const { appName } = useBranding();
  const { setColorScheme } = useMantineColorScheme();
  const computedColorScheme = useComputedColorScheme("light", {
    getInitialValueInEffect: true,
  });

  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<ManageStatus | null>(null);
  const [confirming, setConfirming] = useState(false);

  // The manage token lives only in the URL #fragment (#t=…), so it is never sent
  // to the server on navigation and never appears in logs. Read it on the client
  // inside an effect (reading the hash during render could trip a hydration
  // mismatch). Empty when the link was copied without its fragment.
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    const fromHash = new URLSearchParams(
      window.location.hash.slice(1),
    ).get("t");
    setToken(fromHash ?? "");
  }, []);

  // Once the token is known, fetch the share's status (authorized by the token
  // header). A 404 here is the uniform "no such manageable share" answer — we
  // can't tell apart unknown/expired/legacy/wrong-token, by design.
  useEffect(() => {
    if (token === null) return; // fragment not read yet
    if (!token) {
      setPhase("notfound");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/m/${slug}`, {
          headers: { [MANAGE_TOKEN_HEADER]: token },
        });
        if (cancelled) return;
        if (!res.ok) {
          setPhase("notfound");
          return;
        }
        const data = (await res.json()) as ManageStatus;
        if (cancelled) return;
        setStatus(data);
        setPhase("ready");
      } catch {
        if (!cancelled) setPhase("notfound");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, slug]);

  const onDelete = async () => {
    if (!token) return;
    // Two-step confirm: the first click arms the destructive action.
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setPhase("deleting");
    try {
      const res = await fetch(`/api/m/${slug}`, {
        method: "DELETE",
        headers: { [MANAGE_TOKEN_HEADER]: token },
      });
      if (!res.ok) {
        // A 404 here means it's already gone — treat that as success (the goal,
        // a removed share, is achieved); other errors fall back to notfound.
        setPhase(res.status === 404 ? "deleted" : "notfound");
        return;
      }
      setPhase("deleted");
    } catch {
      setPhase("ready");
      setConfirming(false);
    }
  };

  const exp = status ? describeExpiry(status.expiresAt) : null;
  const expiryText = exp
    ? exp.kind === "never" || exp.kind === "expired"
      ? t(`relexp.${exp.kind}`)
      : t(`relexp.${exp.kind}`, { count: exp.count })
    : "";

  return (
    <Container size="sm" py={60} style={{ position: "relative", minHeight: "100vh" }}>
      {/* Pinned controls — same spot as the upload/download pages. */}
      <Box pos="fixed" top={24} right={24} style={{ zIndex: 2 }}>
        <Group gap="xs">
          <LanguageSwitcher />
          <Tooltip label={t("theme.toggle")} withArrow>
            <ActionIcon
              variant="default"
              size="lg"
              aria-label={t("theme.toggle")}
              onClick={() =>
                setColorScheme(computedColorScheme === "dark" ? "light" : "dark")
              }
            >
              {computedColorScheme === "dark" ? (
                <IconSun size={18} />
              ) : (
                <IconMoon size={18} />
              )}
            </ActionIcon>
          </Tooltip>
        </Group>
      </Box>

      {/* Brand at the top, centered, linking home — same as the download page. */}
      <Center mb={88}>
        <Link href="/" style={{ textDecoration: "none", color: "inherit" }}>
          <Group gap="sm" style={{ cursor: "pointer" }}>
            <Logo size={52} />
            <Title
              order={1}
              fw={500}
              style={{
                fontSize: rem(32),
                letterSpacing: -1,
                fontFamily: "var(--font-bitter), Georgia, serif",
                fontStyle: "italic",
              }}
            >
              {appName}
            </Title>
          </Group>
        </Link>
      </Center>

      <Paper radius="lg" p="xl" maw={460} mx="auto" w="100%" className="fd-glass">
        <Stack align="center" gap="lg">
          <Logo size={48} />

          <Stack align="center" gap={2}>
            <Text fw={700} size="xl" ta="center">
              {t("manage.title")}
            </Text>
            {phase === "ready" && status && (
              <Text c="dimmed" size="sm" ta="center">
                {`${formatBytes(status.size)} · ${expiryText}`}
              </Text>
            )}
            {phase === "ready" &&
              status &&
              status.downloadsLeft !== null && (
                <Text c="dimmed" size="xs">
                  {t("download.downloadsLeft", { count: status.downloadsLeft })}
                </Text>
              )}
          </Stack>

          {phase === "loading" && (
            <Text c="dimmed" size="sm" ta="center">
              {t("manage.loading")}
            </Text>
          )}

          {phase === "notfound" && (
            <Stack align="center" gap="md" w="100%">
              <IconAlertTriangle size={28} style={{ opacity: 0.7 }} />
              <Text c="dimmed" size="sm" ta="center">
                {t("manage.notFound")}
              </Text>
              <Button component={Link} href="/" variant="light">
                {t("notfound.share")}
              </Button>
            </Stack>
          )}

          {phase === "deleted" && (
            <Stack align="center" gap="md" w="100%">
              <IconCheck size={28} style={{ color: "var(--mantine-color-teal-6)" }} />
              <Text fw={600} ta="center">
                {t("manage.deleted")}
              </Text>
              <Button component={Link} href="/" variant="light">
                {t("notfound.share")}
              </Button>
            </Stack>
          )}

          {(phase === "ready" || phase === "deleting") && (
            <Stack w="100%" gap="sm">
              <Text c="dimmed" size="sm" ta="center">
                {t("manage.intro")}
              </Text>
              <Button
                fullWidth
                size="md"
                color="red"
                variant={confirming ? "filled" : "light"}
                leftSection={<IconTrash size={18} />}
                loading={phase === "deleting"}
                onClick={() => void onDelete()}
              >
                {confirming ? t("manage.confirmDelete") : t("manage.delete")}
              </Button>
            </Stack>
          )}
        </Stack>
      </Paper>
    </Container>
  );
}
