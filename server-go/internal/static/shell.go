// Package static renders the SPA HTML shell. The committed webroot/index.html is
// a generic placeholder carrying %%TOKEN%% markers for the per-instance branding
// the operator configures; RenderShell replaces them once at startup so every
// request for "/" (and the SPA fallback) serves the operator's app name and the
// fixed, deliberately generic Open-Graph metadata.
//
// The metadata is GENERIC by design — a shared /d/<slug> link must never leak the
// file's name — so the title/description/OG card come from the branding + a fixed
// description string, NEVER from a share or filename. This mirrors the static
// <head> metadata app/layout.tsx emits.
package static

import (
	"html"
	"strings"
)

// Description is the single, fixed description reused for the tab title's sibling
// meta, search results and social cards. It is copied VERBATIM from the
// DESCRIPTION constant in app/layout.tsx so the two servers' previews never
// drift apart.
const Description = "Drop it like it's hot — your own self-hosted drop zone. Fling a file in, get a link out, watch it self-destruct on schedule. No accounts, no clouds."

// DefaultOGImage is the Open-Graph/Twitter card image path, served by the static
// asset of the same conventional name (the TS side uses app/opengraph-image.png).
const DefaultOGImage = "/opengraph-image.png"

// DefaultLang is the default <html lang>. Per-request Accept-Language negotiation
// is out of scope for this phase; "en" is a safe default.
const DefaultLang = "en"

// ShellTokens are the substitutions applied to the embedded index.html template.
type ShellTokens struct {
	AppName     string
	Description string
	OGImage     string
	Lang        string
	// BaseURL is the public base URL (cfg.BaseURL). When non-empty it is
	// prefixed onto a relative OGImage so og:image/twitter:image resolve to an
	// absolute URL, mirroring metadataBase in app/layout.tsx. When empty the
	// OGImage is left as-is (matching the TS fallback when BASE_URL is unset).
	BaseURL string
}

// RenderShell replaces the %%TOKEN%% markers in the raw template with the given
// values and returns the templated HTML. It is intended to run once at startup
// over the embedded webroot/index.html.
//
// Every substituted value is HTML-escaped before insertion. The tokens land
// inside the <title> element and double-quoted meta content="..." attributes, so
// an operator-set APP_NAME containing ", <, >, or & must not be able to break
// out of the attribute/element and inject markup. Next's Metadata API escapes
// its output the same way; this keeps the Go shell at parity and closes the only
// injection path into the templated HTML.
func RenderShell(template string, tok ShellTokens) string {
	ogImage := absoluteOGImage(tok.BaseURL, tok.OGImage)
	r := strings.NewReplacer(
		"%%APP_NAME%%", html.EscapeString(tok.AppName),
		"%%DESCRIPTION%%", html.EscapeString(tok.Description),
		"%%OG_IMAGE%%", html.EscapeString(ogImage),
		"%%LANG%%", html.EscapeString(tok.Lang),
	)
	return r.Replace(template)
}

// absoluteOGImage prefixes baseURL onto a root-relative ogImage so social/link
// scrapers (which do not resolve relative og:image URLs) get an absolute URL,
// mirroring metadataBase in app/layout.tsx. It joins on a single slash and is a
// no-op when baseURL is empty or ogImage is already absolute (scheme-prefixed).
func absoluteOGImage(baseURL, ogImage string) string {
	if baseURL == "" || ogImage == "" {
		return ogImage
	}
	if strings.Contains(ogImage, "://") {
		return ogImage
	}
	return strings.TrimRight(baseURL, "/") + "/" + strings.TrimLeft(ogImage, "/")
}
