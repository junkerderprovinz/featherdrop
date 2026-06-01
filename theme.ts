"use client";

import { createTheme, type MantineColorsTuple } from "@mantine/core";

// featherdrop visual identity — calm, airy, a single accent that matches the
// logo's gold (light → metallic → deep gold: #F6D981 → #D4AF37 → #A97C0A).
// Mantine wants a 10-step scale; the mid/strong steps (6–8) carry the brand
// gold so buttons, rings and active states echo the feather mark.
const fdgold: MantineColorsTuple = [
  "#fbf7e6", // 0
  "#f4eccf", // 1
  "#ecdda1", // 2
  "#e4cd6f", // 3
  "#dec045", // 4
  "#d9b72c", // 5  light gold (#F6D981 family)
  "#d4af37", // 6  brand gold — primary
  "#b8932a", // 7  metallic
  "#a97c0a", // 8  deep gold
  "#8a6408", // 9
];

export const theme = createTheme({
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
