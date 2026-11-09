package config

import (
	"net/url"
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
	defaultAppName     = "CastleParcel"
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

// The host lands verbatim in the Content-Security-Policy, so it may hold
// nothing that policy syntax gives a meaning to.
var logoHostRe = regexp.MustCompile(`^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]+)?$`)

// LogoOrigin returns the origin of an absolute http(s) APP_LOGO, which the
// Content-Security-Policy then allows for images, or "" for a same-origin path,
// a data URL or no logo.
func (c Config) LogoOrigin() string {
	u, err := url.Parse(strings.TrimSpace(c.AppLogo))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || !logoHostRe.MatchString(u.Host) {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// validLogo reports whether logo is something the page can show under its
// Content-Security-Policy: a same-origin path, an image data URL or an absolute
// http(s) URL.
func validLogo(logo string) bool {
	switch {
	case strings.HasPrefix(logo, "/"):
		return !strings.HasPrefix(logo, "//")
	case strings.HasPrefix(logo, "data:image/"):
		return true
	}
	return Config{AppLogo: logo}.LogoOrigin() != ""
}
