// Package static renders the SPA HTML shell. The embedded webroot/index.html
// carries %%TOKEN%% markers that RenderShell fills once at startup with the
// operator's branding and generic Open Graph metadata. The metadata never comes
// from a share, so a shared /d/<slug> link cannot leak a file name.
package static

import (
	"html"
	"strings"
)

// Description is the fixed page description used for search results and
// social cards.
const Description = "Drop it like it's hot. Your own self-hosted drop zone. Fling a file in, get a link out, watch it self-destruct on schedule. No accounts, no clouds."

// DefaultOGImage is the Open Graph and Twitter card image path.
const DefaultOGImage = "/opengraph-image.png"

// DefaultLang is the <html lang> of the shell.
const DefaultLang = "en"

// ShellTokens are the values RenderShell puts into the template.
type ShellTokens struct {
	AppName     string
	Description string
	OGImage     string
	Lang        string
	// BaseURL, when set, makes a relative OGImage absolute, since link
	// scrapers do not resolve relative og:image URLs.
	BaseURL string
}

// RenderShell replaces the %%TOKEN%% markers in template and returns the HTML.
// Every value is HTML-escaped: the tokens land in <title> and in quoted content
// attributes, and an operator's APP_NAME must not be able to inject markup.
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

// absoluteOGImage joins baseURL and a root-relative ogImage with one slash. It
// returns ogImage unchanged when baseURL is empty or ogImage is already
// absolute.
func absoluteOGImage(baseURL, ogImage string) string {
	if baseURL == "" || ogImage == "" {
		return ogImage
	}
	if strings.Contains(ogImage, "://") {
		return ogImage
	}
	return strings.TrimRight(baseURL, "/") + "/" + strings.TrimLeft(ogImage, "/")
}
