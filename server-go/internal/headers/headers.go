// Package headers sets the security headers every response carries.
package headers

import (
	"net/http"
	"strings"
)

// PermissionsPolicy turns off the browser features the app never uses, so an
// injected script could not reach for them either. Clipboard and fullscreen
// keep their same-origin default for the copy button and the video preview.
const PermissionsPolicy = "accelerometer=(), autoplay=(), bluetooth=(), browsing-topics=(), " +
	"camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), " +
	"magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), " +
	"screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()"

// ContentSecurityPolicy returns the policy for the app. libsodium compiles its
// WebAssembly at runtime, Vue sets inline style attributes, Vite inlines the
// smallest font files as data: URLs, previews are blob: URLs, the PDF preview
// is an <embed> and the crypto worker starts from a blob: URL made from code
// inside the pinned main script. A non-empty logoOrigin, the origin of an
// external APP_LOGO, is allowed for images and nothing else.
func ContentSecurityPolicy(logoOrigin string) string {
	img := "'self' blob: data:"
	if logoOrigin != "" {
		img += " " + logoOrigin
	}
	return strings.Join([]string{
		"default-src 'self'",
		"script-src 'self' 'wasm-unsafe-eval'",
		"style-src 'self' 'unsafe-inline'",
		"img-src " + img,
		"font-src 'self' data:",
		"media-src 'self' blob:",
		"object-src blob:",
		"worker-src 'self' blob:",
		"connect-src 'self'",
		"frame-ancestors 'none'",
		"base-uri 'none'",
		"form-action 'self'",
	}, "; ")
}

// Middleware sets the security headers before next runs, so a handler can
// still replace one for its own response.
func Middleware(csp string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("Content-Security-Policy", csp)
			h.Set("Referrer-Policy", "no-referrer")
			h.Set("Cross-Origin-Opener-Policy", "same-origin")
			h.Set("X-Frame-Options", "DENY")
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("Permissions-Policy", PermissionsPolicy)
			next.ServeHTTP(w, r)
		})
	}
}
