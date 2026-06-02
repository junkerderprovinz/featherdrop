import { Bitter } from "next/font/google";

// Bitter (a humanist slab serif, SIL OFL — free to embed and redistribute) is the
// featherdrop typeface. It matches the logo wordmark and, via the Mantine theme
// (theme.ts), sets EVERY piece of text on the site. next/font/google fetches and
// self-hosts it at build time (subset, hashed, preloaded — no runtime call to
// Google). Loaded with the upright weights the UI uses plus italic (the wordmark
// is italic). Exposed as the CSS variable --font-bitter, consumed by the theme
// and the wordmark.
export const bitter = Bitter({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-bitter",
});
