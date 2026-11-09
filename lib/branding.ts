// Custom branding for self-hosters. Each value falls back to the default when
// its env var is unset or blank, or for the colour, not a 6-digit hex.
export interface Branding {
  appName: string;
  logoUrl: string | null;
  accentColor: string;
}

export const DEFAULT_BRANDING: Branding = {
  appName: "CastleParcel",
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
