import Link from "next/link";
import { Button, Center, Stack, Text, Title } from "@mantine/core";
import { IconFeather } from "@tabler/icons-react";

export default function NotFound() {
  return (
    <Center style={{ minHeight: "100vh" }} p="md">
      <Stack align="center" gap="md">
        <IconFeather size={40} />
        <Title order={2}>Nothing here</Title>
        <Text c="dimmed" ta="center" maw={360}>
          This link is invalid, or the file has expired and been removed.
        </Text>
        <Button component={Link} href="/" variant="light">
          Share a file
        </Button>
      </Stack>
    </Center>
  );
}
