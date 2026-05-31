"use client";

import { createTheme } from "@mantine/core";

// featherdrop visual identity — calm, airy, a single accent.
// Kept intentionally small; most of the look comes from Mantine's defaults
// plus generous spacing and rounded corners.
export const theme = createTheme({
  primaryColor: "violet",
  defaultRadius: "md",
  fontFamily:
    "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
  headings: {
    fontWeight: "700",
  },
});
