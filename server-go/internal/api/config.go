package api

import (
	"net/http"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
)

// configResponse is the GET /api/config body. It carries ONLY the non-secret
// runtime configuration the client needs: the ServerConfigProvider shape
// (baseUrl + the uploadProtected BOOLEAN) plus the resolved BrandingProvider
// shape. The upload password, master key and any token NEVER appear here — only
// the uploadProtected flag is derived from UPLOAD_PASSWORD. Mirrors the props
// app/layout.tsx passes to ServerConfigProvider and BrandingProvider.
type configResponse struct {
	BaseURL         string          `json:"baseUrl"`
	UploadProtected bool            `json:"uploadProtected"`
	Branding        config.Branding `json:"branding"`
}

// ConfigHandler builds GET /api/config. It returns the client-visible runtime
// configuration (base URL, the upload-protected boolean, and resolved branding)
// as JSON. It exposes strings/booleans only — never a secret.
func ConfigHandler(cfg config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, configResponse{
			BaseURL:         cfg.BaseURL,
			UploadProtected: cfg.UploadProtected,
			Branding:        cfg.Branding(),
		})
	}
}
