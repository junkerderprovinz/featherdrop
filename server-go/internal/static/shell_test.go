package static

import (
	"html"
	"strings"
	"testing"
)

// rawTemplate mirrors the structure of the committed webroot/index.html: it must
// carry every token RenderShell substitutes. (The real file is rendered in the
// main package test; this exercises the substitution logic in isolation.)
const rawTemplate = `<!doctype html>
<html lang="%%LANG%%">
  <head>
    <title>%%APP_NAME%%</title>
    <meta name="description" content="%%DESCRIPTION%%" />
    <meta property="og:title" content="%%APP_NAME%%" />
    <meta property="og:site_name" content="%%APP_NAME%%" />
    <meta property="og:image" content="%%OG_IMAGE%%" />
  </head>
  <body><div id="root"></div></body>
</html>`

func TestRenderShell_ReplacesAllTokens(t *testing.T) {
	out := RenderShell(rawTemplate, ShellTokens{
		AppName:     "MyDrop",
		Description: Description,
		OGImage:     DefaultOGImage,
		Lang:        DefaultLang,
	})

	if strings.Contains(out, "%%") {
		t.Fatalf("rendered shell still contains a %%TOKEN%% marker:\n%s", out)
	}
	if !strings.Contains(out, "<title>MyDrop</title>") {
		t.Fatalf("appName not in <title>:\n%s", out)
	}
	if !strings.Contains(out, `<html lang="en">`) {
		t.Fatalf("default lang not applied:\n%s", out)
	}
	if !strings.Contains(out, `content="`+DefaultOGImage+`"`) {
		t.Fatalf("og:image not applied:\n%s", out)
	}
	// The description is HTML-escaped on substitution (it contains an apostrophe),
	// so assert against the escaped form, matching Next's metadata escaping.
	if !strings.Contains(out, html.EscapeString(Description)) {
		t.Fatalf("description not applied:\n%s", out)
	}
}

func TestRenderShell_CustomAppNameReflected(t *testing.T) {
	out := RenderShell(rawTemplate, ShellTokens{
		AppName:     "Acme Files",
		Description: Description,
		OGImage:     DefaultOGImage,
		Lang:        DefaultLang,
	})
	// appName lands in title, og:title and og:site_name (all %%APP_NAME%%).
	if n := strings.Count(out, "Acme Files"); n != 3 {
		t.Fatalf("appName occurrences = %d, want 3 (title + og:title + og:site_name)", n)
	}
}

// A malicious operator-set APP_NAME must not break out of the <title> element or
// the content="..." attributes and inject markup/script into the shell. Next's
// Metadata API HTML-escapes its output; RenderShell must do the same.
func TestRenderShell_EscapesAppNameXSS(t *testing.T) {
	out := RenderShell(rawTemplate, ShellTokens{
		AppName:     `"><script>x</script>`,
		Description: Description,
		OGImage:     DefaultOGImage,
		Lang:        DefaultLang,
	})
	if strings.Contains(out, "<script>x</script>") {
		t.Fatalf("APP_NAME injected an unescaped <script> into the shell:\n%s", out)
	}
	// The raw closing-quote-then-tag sequence must not appear verbatim either,
	// which would close the content="..." attribute and break out.
	if strings.Contains(out, `"><script`) {
		t.Fatalf("APP_NAME broke out of an attribute/element:\n%s", out)
	}
	// The escaped form should be present (proves the value was substituted, just
	// safely encoded).
	if !strings.Contains(out, "&lt;script&gt;") {
		t.Fatalf("escaped APP_NAME not found in shell:\n%s", out)
	}
}

func TestRenderShell_OGImageAbsoluteWithBaseURL(t *testing.T) {
	out := RenderShell(rawTemplate, ShellTokens{
		AppName:     "MyDrop",
		Description: Description,
		OGImage:     DefaultOGImage,
		Lang:        DefaultLang,
		BaseURL:     "https://drop.example.com",
	})
	want := `content="https://drop.example.com/opengraph-image.png"`
	if !strings.Contains(out, want) {
		t.Fatalf("og:image not made absolute from BaseURL; want %q in:\n%s", want, out)
	}
}

func TestRenderShell_OGImageRelativeWithoutBaseURL(t *testing.T) {
	out := RenderShell(rawTemplate, ShellTokens{
		AppName:     "MyDrop",
		Description: Description,
		OGImage:     DefaultOGImage,
		Lang:        DefaultLang,
		// BaseURL unset -> leave OGImage relative, matching the TS fallback.
	})
	if !strings.Contains(out, `content="`+DefaultOGImage+`"`) {
		t.Fatalf("og:image should stay relative when BaseURL is unset:\n%s", out)
	}
}

func TestAbsoluteOGImage(t *testing.T) {
	cases := []struct {
		name    string
		baseURL string
		ogImage string
		want    string
	}{
		{"empty base url stays relative", "", "/opengraph-image.png", "/opengraph-image.png"},
		{"joins on single slash", "https://x.test", "/opengraph-image.png", "https://x.test/opengraph-image.png"},
		{"trims trailing base slash", "https://x.test/", "/opengraph-image.png", "https://x.test/opengraph-image.png"},
		{"already absolute is left alone", "https://x.test", "https://cdn.test/c.png", "https://cdn.test/c.png"},
		{"empty image stays empty", "https://x.test", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := absoluteOGImage(tc.baseURL, tc.ogImage); got != tc.want {
				t.Fatalf("absoluteOGImage(%q, %q) = %q, want %q", tc.baseURL, tc.ogImage, got, tc.want)
			}
		})
	}
}
