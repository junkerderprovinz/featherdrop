"use client";

import { createTheme, type MantineColorsTuple } from "@mantine/core";
import { accentTuple, DEFAULT_BRANDING } from "@/lib/branding";

// featherdrop visual identity — calm, airy, a single accent that matches the
// logo's gold by default. Self-hosters can override the accent colour; the
// 10-step Mantine scale is derived from the chosen hex so buttons, rings and
// active states echo it (step 6 = base, lighter below, darker above).
export function createAppTheme(
  accentColor: string = DEFAULT_BRANDING.accentColor,
) {
  const fdgold = accentTuple(accentColor) as unknown as MantineColorsTuple;
  return createTheme({
    colors: { fdgold },
    primaryColor: "fdgold",
    primaryShade: { light: 7, dark: 6 },
    defaultRadius: "md",
    fontFamily:
      "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
    headings: {
      fontWeight: "700",
    },
  });
}

// Default theme for imports that don't override the accent.
export const theme = createAppTheme();
