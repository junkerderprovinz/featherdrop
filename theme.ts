// NOTE: do NOT add "use client" here. createAppTheme() is called from the server
// component app/layout.tsx; a "use client" export imported into a Server Component
// becomes a non-callable client reference ("u is not a function" at render). Theme
// creation is pure data (createTheme returns a plain object), so this module is
// isomorphic and runs on the server, producing a serializable theme for the
// client <MantineProvider>.
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
    // Bitter (the logo/wordmark typeface) is used for ALL text on the site.
    fontFamily: "var(--font-bitter), Georgia, serif",
    headings: {
      fontFamily: "var(--font-bitter), Georgia, serif",
      fontWeight: "700",
    },
  });
}

// Default theme for imports that don't override the accent.
export const theme = createAppTheme();
