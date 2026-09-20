package config

import (
	"regexp"
	"strings"
)

// Branding is the operator's display identity, the same shape as Branding in
// lib/branding.ts. An empty LogoURL means no logo.
type Branding struct {
	AppName     string `json:"appName"`
	LogoURL     string `json:"logoUrl"`
	AccentColor string `json:"accentColor"`
}

const (
	defaultAppName     = "featherdrop"
	defaultLogoURL     = ""
	defaultAccentColor = "#d4af37"
)

var hexRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// normalizeHex returns a 6-digit CSS hex colour in lower case, or "" when value
// is not one.
func normalizeHex(value string) string {
	hex := strings.TrimSpace(value)
	if hexRe.MatchString(hex) {
		return strings.ToLower(hex)
	}
	return ""
}

// ResolveBranding applies the defaults of lib/branding.ts to the raw env
// values: a blank name or an invalid accent colour falls back to the default,
// a blank logo means none.
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

// Branding returns the resolved branding of c.
func (c Config) Branding() Branding {
	return ResolveBranding(c.AppName, c.AppLogo, c.AccentColor)
}
