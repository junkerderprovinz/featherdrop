// The page behind a management link: one button that deletes the share. The
// token comes from the fragment, which the browser never sends to the server.
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, Center, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Logo } from "@/components/Logo";
import { manageTokenFromFragment, revokeShare } from "@/lib/e2e/manage-link";

type Phase = "ready" | "deleting" | "deleted" | "notfound";

export function ManagePage() {
  const { slug = "" } = useParams();
  const { t } = useTranslation();
  const [token] = useState(() => manageTokenFromFragment(window.location.hash));
  const [phase, setPhase] = useState<Phase>(token ? "ready" : "notfound");
  const [confirming, setConfirming] = useState(false);

  const onDelete = async () => {
    // The first click only arms the button.
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setPhase("deleting");
    try {
      const outcome = await revokeShare(slug, token);
      setPhase(outcome === "deleted" ? "deleted" : "notfound");
    } catch {
      setPhase("ready");
      setConfirming(false);
      notifications.show({ color: "red", message: t("manage.deleteFailed") });
    }
  };

  return (
    <Center style={{ minHeight: "100vh" }} p="md">
      <Stack align="center" gap="md" maw={420}>
        <Logo size={40} />
        <Title order={2}>
          {phase === "deleted" ? t("manage.deleted") : t("manage.title")}
        </Title>
        {phase === "notfound" && (
          <Text c="dimmed" ta="center">
            {t("manage.notFound")}
          </Text>
        )}
        {(phase === "ready" || phase === "deleting") && (
          <>
            <Text c="dimmed" ta="center">
              {t("manage.intro")}
            </Text>
            <Button
              color="red"
              variant={confirming ? "filled" : "light"}
              leftSection={<IconTrash size={18} />}
              loading={phase === "deleting"}
              onClick={() => void onDelete()}
            >
              {confirming ? t("manage.confirmDelete") : t("manage.delete")}
            </Button>
          </>
        )}
        {(phase === "deleted" || phase === "notfound") && (
          <Button component={Link} to="/" variant="light">
            {t("notfound.share")}
          </Button>
        )}
      </Stack>
    </Center>
  );
}
