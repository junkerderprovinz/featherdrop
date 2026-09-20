import { createTheme, type MantineColorsTuple } from "@mantine/core";
import { accentTuple, DEFAULT_BRANDING } from "@/lib/branding";

// One accent colour, the logo's gold unless the operator picks another. The
// 10-step Mantine scale is derived from it, with step 6 as the base.
export function createAppTheme(
  accentColor: string = DEFAULT_BRANDING.accentColor,
) {
  const fdgold = accentTuple(accentColor) as unknown as MantineColorsTuple;
  return createTheme({
    colors: { fdgold },
    primaryColor: "fdgold",
    primaryShade: { light: 7, dark: 6 },
    defaultRadius: "md",
    // Sansation for all UI text; the wordmark uses Bitter.
    fontFamily:
      "Sansation, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
    headings: {
      fontFamily:
        "Sansation, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
      fontWeight: "700",
    },
  });
}

export const theme = createAppTheme();
