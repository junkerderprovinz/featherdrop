package api

import (
	"net/http"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
)

// configResponse is the GET /api/config body. It carries only non-secret
// values: uploadProtected is derived from UPLOAD_PASSWORD, the password itself
// never leaves the server. MaxExpiry ("" for no cap) lets the UI hide options
// finalize would reject, and DefaultExpiry is preselected when the visitor has
// no stored preference.
type configResponse struct {
	BaseURL         string          `json:"baseUrl"`
	UploadProtected bool            `json:"uploadProtected"`
	MaxExpiry       string          `json:"maxExpiry"`
	DefaultExpiry   string          `json:"defaultExpiry"`
	Branding        config.Branding `json:"branding"`
}

// ConfigHandler builds GET /api/config, the client-visible runtime
// configuration.
func ConfigHandler(cfg config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, configResponse{
			BaseURL:         cfg.BaseURL,
			UploadProtected: cfg.UploadProtected,
			MaxExpiry:       cfg.MaxExpiry,
			DefaultExpiry:   cfg.DefaultExpiry,
			Branding:        cfg.Branding(),
		})
	}
}
