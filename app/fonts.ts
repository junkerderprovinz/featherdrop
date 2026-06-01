import { Bitter } from "next/font/google";

// The featherdrop wordmark is set in Bitter (a humanist slab serif, SIL OFL —
// free to embed and redistribute). Medium 500, italic. next/font/google fetches
// and self-hosts it at build time (subset, hashed, preloaded — no runtime call
// to Google). Exposed as a CSS variable so only the wordmark opts in.
export const wordmark = Bitter({
  subsets: ["latin"],
  weight: "500",
  style: "italic",
  display: "swap",
  variable: "--font-wordmark",
});
