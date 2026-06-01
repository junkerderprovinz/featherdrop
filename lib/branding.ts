// Custom branding for self-hosters. Each value falls back to the default
// featherdrop branding when its env var is unset, blank, or (for the colour)
// not a valid 6-digit hex. Resolved once on the server and handed to the client
// via BrandingProvider so the wordmark/logo/accent reflect the operator's setup.
export interface Branding {
  appName: string;
  logoUrl: string | null;
  accentColor: string;
}

export const DEFAULT_BRANDING: Branding = {
  appName: "featherdrop",
  logoUrl: null,
  accentColor: "#d4af37",
};

/** Validate a CSS hex colour like `#d4af37`; returns it lowercased, else null. */
export function normalizeHex(value?: string): string | null {
  if (!value) return null;
  const hex = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : null;
}

export function resolveBranding(env: {
  APP_NAME?: string;
  APP_LOGO?: string;
  ACCENT_COLOR?: string;
}): Branding {
  return {
    appName: env.APP_NAME?.trim() || DEFAULT_BRANDING.appName,
    logoUrl: env.APP_LOGO?.trim() || null,
    accentColor: normalizeHex(env.ACCENT_COLOR) ?? DEFAULT_BRANDING.accentColor,
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r: number, g: number, b: number): string {
  const clamp = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
  return "#" + [r, g, b].map((x) => clamp(x).toString(16).padStart(2, "0")).join("");
}

// A 10-step Mantine colour tuple from a base hex: steps 0–5 blend toward white
// (lightest first), step 6 is the base colour, steps 7–9 blend toward black.
export function accentTuple(hex: string): string[] {
  const [r, g, b] = hexToRgb(hex);
  const lighten = (t: number) =>
    toHex(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t);
  const darken = (t: number) => toHex(r * (1 - t), g * (1 - t), b * (1 - t));
  return [
    lighten(0.92),
    lighten(0.82),
    lighten(0.64),
    lighten(0.44),
    lighten(0.26),
    lighten(0.1),
    hex.toLowerCase(),
    darken(0.16),
    darken(0.32),
    darken(0.48),
  ];
}
