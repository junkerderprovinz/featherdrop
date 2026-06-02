import { Bitter } from "next/font/google";

// Bitter (a humanist slab serif, SIL OFL) — used ONLY for the wordmark/logo text
// (italic 500). next/font/google self-hosts it at build time. Var: --font-bitter.
// The UI typeface for all other text is Sansation, self-hosted via
// @fontsource/sansation (imported in app/layout.tsx) and applied through the
// Mantine theme (theme.ts) — no runtime call to Google.
export const bitter = Bitter({
  subsets: ["latin"],
  weight: "500",
  style: "italic",
  display: "swap",
  variable: "--font-bitter",
});
