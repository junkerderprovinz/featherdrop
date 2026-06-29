package config

import (
	"regexp"
	"strings"
)

// Branding is the operator-customisable display identity (app name, logo, accent
// colour). It mirrors the Branding interface in lib/branding.ts. logoUrl is the
// empty string when no logo is configured (the TS side uses null; the client
// reads it as a falsy value either way, and JSON ""/null both render no logo).
type Branding struct {
	AppName     string `json:"appName"`
	LogoURL     string `json:"logoUrl"`
	AccentColor string `json:"accentColor"`
}

// Default branding, mirroring DEFAULT_BRANDING in lib/branding.ts. The default
// logoUrl is null on the TS side; we represent "no logo" as the empty string.
const (
	defaultAppName     = "featherdrop"
	defaultLogoURL     = ""
	defaultAccentColor = "#d4af37"
)

// hexRe validates a 6-digit CSS hex colour like "#d4af37". Mirrors the regex in
// lib/branding.ts normalizeHex.
var hexRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// normalizeHex validates a CSS hex colour, returning it lowercased, or "" when
// blank or not a valid 6-digit hex. Mirrors lib/branding.ts normalizeHex (null
// -> "" here).
func normalizeHex(value string) string {
	hex := strings.TrimSpace(value)
	if hexRe.MatchString(hex) {
		return strings.ToLower(hex)
	}
	return ""
}

// ResolveBranding applies the same defaulting as lib/branding.ts resolveBranding:
// a blank-after-trim APP_NAME falls back to the default name; a blank APP_LOGO
// yields no logo (""); an invalid/blank ACCENT_COLOR falls back to the default
// accent. The three string inputs are the raw env values (cfg.AppName etc.).
func ResolveBranding(appName, appLogo, accentColor string) Branding {
	name := strings.TrimSpace(appName)
	if name == "" {
		name = defaultAppName
	}
	logo := strings.TrimSpace(appLogo)
	if logo == "" {
		logo = defaultLogoURL
	}
	accent := normalizeHex(accentColor)
	if accent == "" {
		accent = defaultAccentColor
	}
	return Branding{AppName: name, LogoURL: logo, AccentColor: accent}
}

// Branding resolves this config's branding strings (the raw env values stored on
// Config) into the defaulted Branding, mirroring how lib/config.ts builds
// BRANDING via resolveBranding.
func (c Config) Branding() Branding {
	return ResolveBranding(c.AppName, c.AppLogo, c.AccentColor)
}
