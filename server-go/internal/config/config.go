// Package config reads the server's runtime configuration from the environment.
// DATA_DIR holds the uploaded files and CONFIG_DIR the SQLite metadata database;
// CONFIG_DIR defaults to DATA_DIR so single-volume installs keep working.
package config

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/share"
)

// Config holds the resolved runtime configuration, read once by Load.
type Config struct {
	DataDir    string // DATA_DIR, default "./data"
	ConfigDir  string // CONFIG_DIR, default DataDir
	UploadsDir string // finalized shares
	TmpDir     string // tus uploads in progress
	DBPath     string

	// MaxFileSize is the upload limit in bytes; 0 means unlimited.
	MaxFileSize int64
	// DefaultExpiry applies when the uploader picks none. Validate clamps it
	// to MaxExpiry.
	DefaultExpiry string
	// BaseURL builds share links. Validate clears it when it is not an
	// absolute http(s) URL.
	BaseURL string

	// MaxExpiry caps the selectable expiry; "" means no cap.
	MaxExpiry string
	// StorageQuota caps the total stored bytes; 0 means unlimited.
	StorageQuota int64
	// RateLimit turns on the per-client-IP token buckets.
	RateLimit bool
	// TrustProxy takes the client IP from the first X-Forwarded-For entry,
	// which is only safe behind a proxy that sets it.
	TrustProxy bool

	// Load keeps these verbatim and Validate parses them, because an invalid
	// value has to stop the boot and Load returns no error.
	rawStorageQuota string
	rawRateLimit    string
	rawTrustProxy   string

	UploadPassword  string
	UploadProtected bool

	AppName     string
	AppLogo     string
	AccentColor string

	Port string
}

func getenv(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

// Load reads the configuration from the environment and applies the defaults.
func Load() Config {
	dataDir := getenv("DATA_DIR", "./data")
	configDir := getenv("CONFIG_DIR", dataDir)

	// A non-numeric MAX_FILE_SIZE falls back to unlimited.
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

		MaxExpiry:       getenv("MAX_EXPIRY", ""),
		RateLimit:       true,
		TrustProxy:      false,
		rawStorageQuota: getenv("STORAGE_QUOTA", ""),
		rawRateLimit:    getenv("RATE_LIMIT", ""),
		rawTrustProxy:   getenv("TRUST_PROXY", ""),

		UploadPassword:  uploadPassword,
		UploadProtected: len(uploadPassword) > 0,

		AppName:     getenv("APP_NAME", ""),
		AppLogo:     getenv("APP_LOGO", ""),
		AccentColor: getenv("ACCENT_COLOR", ""),

		Port: getenv("PORT", "3000"),
	}
}

const expiryTokens = `"1h", "6h", "1d", "7d", "30d" or "never"`

// Validate parses the guardrail variables and checks the configuration at boot.
// It clamps DefaultExpiry to the cap and clears a bad BaseURL, reporting both
// as warnings for main to log; a non-nil error means the server must not start.
func (c *Config) Validate() (warnings []string, err error) {
	if c.MaxExpiry != "" && !share.IsValidExpiry(c.MaxExpiry) {
		return warnings, fmt.Errorf(
			"MAX_EXPIRY=%q is invalid: accepted values are %s (empty = no cap)",
			c.MaxExpiry, expiryTokens)
	}

	if c.rawStorageQuota != "" {
		n, perr := strconv.ParseInt(c.rawStorageQuota, 10, 64)
		if perr != nil || n < 0 {
			return warnings, fmt.Errorf(
				"STORAGE_QUOTA=%q is invalid: accepted values are a non-negative integer byte count (empty or 0 = unlimited)",
				c.rawStorageQuota)
		}
		c.StorageQuota = n
	}

	if c.rawRateLimit != "" {
		v, perr := strconv.ParseBool(c.rawRateLimit)
		if perr != nil {
			return warnings, fmt.Errorf(
				`RATE_LIMIT=%q is invalid: accepted values are "true" and "false" (default true)`,
				c.rawRateLimit)
		}
		c.RateLimit = v
	}
	if c.rawTrustProxy != "" {
		v, perr := strconv.ParseBool(c.rawTrustProxy)
		if perr != nil {
			return warnings, fmt.Errorf(
				`TRUST_PROXY=%q is invalid: accepted values are "true" and "false" (default false)`,
				c.rawTrustProxy)
		}
		c.TrustProxy = v
	}

	// Clamping instead of refusing keeps an install booting when a stricter cap
	// meets its old default. An unknown token would store no expiry, so it is
	// clamped too.
	if c.MaxExpiry != "" && !share.ExpiryWithinCap(c.DefaultExpiry, c.MaxExpiry) {
		warnings = append(warnings, fmt.Sprintf(
			"DEFAULT_EXPIRY=%q exceeds MAX_EXPIRY=%q; clamping the default expiry to the cap",
			c.DefaultExpiry, c.MaxExpiry))
		c.DefaultExpiry = c.MaxExpiry
	}

	// Without BASE_URL, share links use the request origin.
	if c.BaseURL != "" {
		u, perr := url.Parse(c.BaseURL)
		if perr != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			warnings = append(warnings, fmt.Sprintf(
				"BASE_URL=%q is not an absolute http(s) URL; ignoring it", c.BaseURL))
			c.BaseURL = ""
		}
	}

	if c.UploadProtected && len(c.UploadPassword) < 8 {
		warnings = append(warnings,
			"UPLOAD_PASSWORD is shorter than 8 characters; consider a longer secret")
	}

	return warnings, nil
}

// EnsureDataDirs creates the data directories; it is safe to call repeatedly.
func (c Config) EnsureDataDirs() error {
	for _, dir := range []string{c.DataDir, c.UploadsDir, c.TmpDir, c.ConfigDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return nil
}
