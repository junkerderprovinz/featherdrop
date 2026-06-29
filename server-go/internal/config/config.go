// Package config is the single source of truth for the Go server's runtime
// configuration. It mirrors the existing TypeScript lib/config.ts so the Go
// binary is a drop-in replacement on the same volumes and environment.
//
// DATA_DIR holds the bulk uploaded files; CONFIG_DIR holds the small SQLite
// metadata database. CONFIG_DIR defaults to DATA_DIR, so existing single-volume
// installs keep working unchanged.
package config

import (
	"os"
	"path/filepath"
	"strconv"
)

// Config holds the resolved runtime configuration. Values are read once from
// the environment via Load.
type Config struct {
	// DataDir holds the bulk uploaded files (DATA_DIR, default "./data").
	DataDir string
	// ConfigDir holds the SQLite metadata DB (CONFIG_DIR, default = DataDir).
	ConfigDir string
	// UploadsDir = DataDir/uploads (finalized shared files).
	UploadsDir string
	// TmpDir = DataDir/tmp (in-progress tus uploads).
	TmpDir string
	// DBPath = ConfigDir/db.sqlite (metadata database).
	DBPath string

	// MaxFileSize is the max upload size in bytes. 0 = unlimited.
	MaxFileSize int64
	// DefaultExpiry applied when the uploader does not pick one (default "7d").
	DefaultExpiry string
	// BaseURL is the public base URL used to build share links (default "").
	BaseURL string

	// UploadPassword is the optional upload gate secret (default "").
	UploadPassword string
	// UploadProtected is true when UploadPassword is non-empty.
	UploadProtected bool

	// Branding strings, carried through unchanged this phase.
	AppName     string
	AppLogo     string
	AccentColor string

	// Port the server listens on (default "3000").
	Port string
}

// getenv returns the environment value for key, or def when unset.
func getenv(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

// Load reads the configuration from the environment, applying the same
// defaults and derivations as the TypeScript lib/config.ts.
func Load() Config {
	dataDir := getenv("DATA_DIR", "./data")
	configDir := getenv("CONFIG_DIR", dataDir)

	// MAX_FILE_SIZE: int bytes, default 0 (unlimited). Mirror the TS
	// Number(...) behaviour loosely: a non-numeric value falls back to 0.
	maxFileSize := int64(0)
	if v := os.Getenv("MAX_FILE_SIZE"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			maxFileSize = n
		}
	}

	uploadPassword := getenv("UPLOAD_PASSWORD", "")

	return Config{
		DataDir:    dataDir,
		ConfigDir:  configDir,
		UploadsDir: filepath.Join(dataDir, "uploads"),
		TmpDir:     filepath.Join(dataDir, "tmp"),
		DBPath:     filepath.Join(configDir, "db.sqlite"),

		MaxFileSize:   maxFileSize,
		DefaultExpiry: getenv("DEFAULT_EXPIRY", "7d"),
		BaseURL:       getenv("BASE_URL", ""),

		UploadPassword:  uploadPassword,
		UploadProtected: len(uploadPassword) > 0,

		AppName:     getenv("APP_NAME", ""),
		AppLogo:     getenv("APP_LOGO", ""),
		AccentColor: getenv("ACCENT_COLOR", ""),

		Port: getenv("PORT", "3000"),
	}
}

// EnsureDataDirs creates the data sub-directories; safe to call repeatedly.
func (c Config) EnsureDataDirs() error {
	for _, dir := range []string{c.DataDir, c.UploadsDir, c.TmpDir, c.ConfigDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return nil
}
