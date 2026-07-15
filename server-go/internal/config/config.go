// Package config is the single source of truth for the Go server's runtime
// configuration. It mirrors the existing TypeScript lib/config.ts so the Go
// binary is a drop-in replacement on the same volumes and environment.
//
// DATA_DIR holds the bulk uploaded files; CONFIG_DIR holds the small SQLite
// metadata database. CONFIG_DIR defaults to DATA_DIR, so existing single-volume
// installs keep working unchanged.
package config

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/share"
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
	// Validate clamps it to MaxExpiry when a cap is configured.
	DefaultExpiry string
	// BaseURL is the public base URL used to build share links (default "").
	// Validate clears it (with a warning) when it is not an absolute http(s) URL.
	BaseURL string

	// MaxExpiry caps the uploader-selectable expiry (MAX_EXPIRY, same tokens as
	// DEFAULT_EXPIRY; "" = no cap). Validated by Validate.
	MaxExpiry string
	// StorageQuota caps the total stored share bytes (STORAGE_QUOTA, bytes;
	// 0 = unlimited). Parsed by Validate.
	StorageQuota int64
	// RateLimit toggles the per-client-IP token buckets (RATE_LIMIT, default
	// true). Parsed by Validate.
	RateLimit bool
	// TrustProxy: when true the client IP is taken from the FIRST entry of
	// X-Forwarded-For (TRUST_PROXY, default false — never trust XFF unless the
	// operator says a trusted proxy sets it). Parsed by Validate.
	TrustProxy bool

	// Raw (unparsed) env values for the strictly-validated v6.1 guardrail
	// variables. Load stores them verbatim; Validate parses them into the typed
	// fields above and returns a fatal error for an invalid value.
	rawStorageQuota string
	rawRateLimit    string
	rawTrustProxy   string

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

		// Guardrail envs: defaults here, strict parsing/validation in Validate
		// (an invalid value must abort boot with a clear error, which Load —
		// error-free by design — cannot do).
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

// expiryTokens is the accepted-values list used in MAX_EXPIRY error messages.
const expiryTokens = `"1h", "6h", "1d", "7d", "30d" or "never"`

// Validate applies the boot-time configuration validation and finishes parsing
// the strictly-validated guardrail envs (MAX_EXPIRY, STORAGE_QUOTA, RATE_LIMIT,
// TRUST_PROXY). It mutates the receiver: DEFAULT_EXPIRY is clamped to the
// MAX_EXPIRY cap and a non-absolute BASE_URL is cleared — each with a warning.
//
// warnings are human-readable, non-fatal findings the caller should log; a
// non-nil err means the server must refuse to boot (the message names the
// offending variable and the accepted values). Returned as data rather than
// logged here so main owns all logging and tests stay log-free.
func (c *Config) Validate() (warnings []string, err error) {
	// MAX_EXPIRY: must be one of the expiry tokens ("" = no cap).
	if c.MaxExpiry != "" && !share.IsValidExpiry(c.MaxExpiry) {
		return warnings, fmt.Errorf(
			"MAX_EXPIRY=%q is invalid: accepted values are %s (empty = no cap)",
			c.MaxExpiry, expiryTokens)
	}

	// STORAGE_QUOTA: a non-negative integer byte count ("" / 0 = unlimited).
	if c.rawStorageQuota != "" {
		n, perr := strconv.ParseInt(c.rawStorageQuota, 10, 64)
		if perr != nil || n < 0 {
			return warnings, fmt.Errorf(
				"STORAGE_QUOTA=%q is invalid: accepted values are a non-negative integer byte count (empty or 0 = unlimited)",
				c.rawStorageQuota)
		}
		c.StorageQuota = n
	}

	// RATE_LIMIT / TRUST_PROXY: booleans ("" = their defaults: true / false).
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

	// DEFAULT_EXPIRY vs the cap: clamp rather than refuse, so a stricter
	// MAX_EXPIRY never breaks an existing install that kept its old default.
	// An unknown DEFAULT_EXPIRY token counts as "never" (ExpiryToTimestamp
	// stores NULL for it), so it is clamped too rather than bypassing the cap.
	if c.MaxExpiry != "" && !share.ExpiryWithinCap(c.DefaultExpiry, c.MaxExpiry) {
		warnings = append(warnings, fmt.Sprintf(
			"DEFAULT_EXPIRY=%q exceeds MAX_EXPIRY=%q; clamping the default expiry to the cap",
			c.DefaultExpiry, c.MaxExpiry))
		c.DefaultExpiry = c.MaxExpiry
	}

	// BASE_URL: when set it must be an absolute http(s) URL. A bad value is
	// ignored (share links fall back to the request origin) — warn, don't refuse.
	if c.BaseURL != "" {
		u, perr := url.Parse(c.BaseURL)
		if perr != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			warnings = append(warnings, fmt.Sprintf(
				"BASE_URL=%q is not an absolute http(s) URL; ignoring it", c.BaseURL))
			c.BaseURL = ""
		}
	}

	// UPLOAD_PASSWORD: a very short secret still works, but is trivially
	// guessable — surface it. (The value itself is never logged.)
	if c.UploadProtected && len(c.UploadPassword) < 8 {
		warnings = append(warnings,
			"UPLOAD_PASSWORD is shorter than 8 characters; consider a longer secret")
	}

	return warnings, nil
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
