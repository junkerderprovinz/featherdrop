package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// configEnvVars are all the environment variables Load reads.
var configEnvVars = []string{
	"DATA_DIR", "CONFIG_DIR", "MAX_FILE_SIZE", "DEFAULT_EXPIRY", "BASE_URL",
	"UPLOAD_PASSWORD", "APP_NAME", "APP_LOGO", "ACCENT_COLOR", "PORT",
	"MAX_EXPIRY", "STORAGE_QUOTA", "RATE_LIMIT", "TRUST_PROXY",
}

// clearConfigEnv unsets every config env var for the duration of the test,
// restoring the originals via t.Cleanup. This lets Load apply its built-in
// defaults regardless of the host environment. Subsequent t.Setenv calls in a
// test override individual vars on top of this clean baseline.
func clearConfigEnv(t *testing.T) {
	t.Helper()
	for _, k := range configEnvVars {
		orig, had := os.LookupEnv(k)
		if err := os.Unsetenv(k); err != nil {
			t.Fatalf("unsetenv %s: %v", k, err)
		}
		k, orig, had := k, orig, had
		t.Cleanup(func() {
			if had {
				_ = os.Setenv(k, orig)
			} else {
				_ = os.Unsetenv(k)
			}
		})
	}
}

func TestLoadDefaults(t *testing.T) {
	clearConfigEnv(t)

	cfg := Load()

	if cfg.DataDir != "./data" {
		t.Errorf("DataDir = %q, want ./data", cfg.DataDir)
	}
	if cfg.ConfigDir != cfg.DataDir {
		t.Errorf("ConfigDir = %q, want == DataDir %q", cfg.ConfigDir, cfg.DataDir)
	}
	if want := filepath.Join("./data", "uploads"); cfg.UploadsDir != want {
		t.Errorf("UploadsDir = %q, want %q", cfg.UploadsDir, want)
	}
	if want := filepath.Join("./data", "tmp"); cfg.TmpDir != want {
		t.Errorf("TmpDir = %q, want %q", cfg.TmpDir, want)
	}
	if want := filepath.Join("./data", "db.sqlite"); cfg.DBPath != want {
		t.Errorf("DBPath = %q, want %q", cfg.DBPath, want)
	}
	if cfg.MaxFileSize != 0 {
		t.Errorf("MaxFileSize = %d, want 0", cfg.MaxFileSize)
	}
	if cfg.DefaultExpiry != "7d" {
		t.Errorf("DefaultExpiry = %q, want 7d", cfg.DefaultExpiry)
	}
	if cfg.BaseURL != "" {
		t.Errorf("BaseURL = %q, want empty", cfg.BaseURL)
	}
	if cfg.Port != "3000" {
		t.Errorf("Port = %q, want 3000", cfg.Port)
	}
	if cfg.UploadProtected {
		t.Errorf("UploadProtected = true, want false")
	}
}

func TestUploadPasswordFlipsProtected(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("UPLOAD_PASSWORD", "s3cret")

	cfg := Load()
	if cfg.UploadPassword != "s3cret" {
		t.Errorf("UploadPassword = %q, want s3cret", cfg.UploadPassword)
	}
	if !cfg.UploadProtected {
		t.Errorf("UploadProtected = false, want true")
	}
}

func TestConfigDirOverrideChangesDBPath(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("DATA_DIR", "/srv/data")
	t.Setenv("CONFIG_DIR", "/srv/config")

	cfg := Load()
	if cfg.DataDir != "/srv/data" {
		t.Errorf("DataDir = %q, want /srv/data", cfg.DataDir)
	}
	if cfg.ConfigDir != "/srv/config" {
		t.Errorf("ConfigDir = %q, want /srv/config", cfg.ConfigDir)
	}
	if want := filepath.Join("/srv/config", "db.sqlite"); cfg.DBPath != want {
		t.Errorf("DBPath = %q, want %q", cfg.DBPath, want)
	}
	// Uploads/tmp still derive from DATA_DIR, not CONFIG_DIR.
	if want := filepath.Join("/srv/data", "uploads"); cfg.UploadsDir != want {
		t.Errorf("UploadsDir = %q, want %q", cfg.UploadsDir, want)
	}
}

func TestMaxFileSizeParsed(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("MAX_FILE_SIZE", "1048576")

	cfg := Load()
	if cfg.MaxFileSize != 1048576 {
		t.Errorf("MaxFileSize = %d, want 1048576", cfg.MaxFileSize)
	}
}

// ---------------------------------------------------------------------------
// Validate — the v6.1 guardrail envs + boot-time warnings
// ---------------------------------------------------------------------------

// loadAndValidate runs Load + Validate on the current (cleared) env.
func loadAndValidate(t *testing.T) (Config, []string, error) {
	t.Helper()
	cfg := Load()
	warnings, err := cfg.Validate()
	return cfg, warnings, err
}

func TestValidate_MaxExpiry(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		wantErr bool
	}{
		{"empty = no cap", "", false},
		{"1h", "1h", false},
		{"6h", "6h", false},
		{"1d", "1d", false},
		{"7d", "7d", false},
		{"30d", "30d", false},
		{"never", "never", false},
		{"unknown token", "99y", true},
		{"uppercase rejected", "7D", true},
		{"whitespace rejected", " 7d", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clearConfigEnv(t)
			if tt.value != "" {
				t.Setenv("MAX_EXPIRY", tt.value)
			}
			cfg, _, err := loadAndValidate(t)
			if (err != nil) != tt.wantErr {
				t.Fatalf("Validate err = %v, wantErr %v", err, tt.wantErr)
			}
			if err != nil {
				if !strings.Contains(err.Error(), "MAX_EXPIRY") {
					t.Errorf("error %q must name MAX_EXPIRY", err)
				}
				return
			}
			if cfg.MaxExpiry != tt.value {
				t.Errorf("MaxExpiry = %q, want %q", cfg.MaxExpiry, tt.value)
			}
		})
	}
}

func TestValidate_StorageQuota(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		want    int64
		wantErr bool
	}{
		{"empty = unlimited", "", 0, false},
		{"zero = unlimited", "0", 0, false},
		{"bytes", "1048576", 1048576, false},
		{"large", "1099511627776", 1099511627776, false},
		{"negative", "-5", 0, true},
		{"non-numeric", "10GB", 0, true},
		{"float", "1.5", 0, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clearConfigEnv(t)
			if tt.value != "" {
				t.Setenv("STORAGE_QUOTA", tt.value)
			}
			cfg, _, err := loadAndValidate(t)
			if (err != nil) != tt.wantErr {
				t.Fatalf("Validate err = %v, wantErr %v", err, tt.wantErr)
			}
			if err != nil {
				if !strings.Contains(err.Error(), "STORAGE_QUOTA") {
					t.Errorf("error %q must name STORAGE_QUOTA", err)
				}
				return
			}
			if cfg.StorageQuota != tt.want {
				t.Errorf("StorageQuota = %d, want %d", cfg.StorageQuota, tt.want)
			}
		})
	}
}

func TestValidate_RateLimit(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		want    bool
		wantErr bool
	}{
		{"empty defaults true", "", true, false},
		{"true", "true", true, false},
		{"false", "false", false, false},
		{"invalid", "banana", true, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clearConfigEnv(t)
			if tt.value != "" {
				t.Setenv("RATE_LIMIT", tt.value)
			}
			cfg, _, err := loadAndValidate(t)
			if (err != nil) != tt.wantErr {
				t.Fatalf("Validate err = %v, wantErr %v", err, tt.wantErr)
			}
			if err != nil {
				if !strings.Contains(err.Error(), "RATE_LIMIT") {
					t.Errorf("error %q must name RATE_LIMIT", err)
				}
				return
			}
			if cfg.RateLimit != tt.want {
				t.Errorf("RateLimit = %v, want %v", cfg.RateLimit, tt.want)
			}
		})
	}
}

func TestValidate_TrustProxy(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		want    bool
		wantErr bool
	}{
		{"empty defaults false", "", false, false},
		{"true", "true", true, false},
		{"false", "false", false, false},
		{"invalid", "yes please", false, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clearConfigEnv(t)
			if tt.value != "" {
				t.Setenv("TRUST_PROXY", tt.value)
			}
			cfg, _, err := loadAndValidate(t)
			if (err != nil) != tt.wantErr {
				t.Fatalf("Validate err = %v, wantErr %v", err, tt.wantErr)
			}
			if err != nil {
				if !strings.Contains(err.Error(), "TRUST_PROXY") {
					t.Errorf("error %q must name TRUST_PROXY", err)
				}
				return
			}
			if cfg.TrustProxy != tt.want {
				t.Errorf("TrustProxy = %v, want %v", cfg.TrustProxy, tt.want)
			}
		})
	}
}

func TestValidate_DefaultExpiryClamped(t *testing.T) {
	tests := []struct {
		name        string
		defaultExp  string
		maxExpiry   string
		wantDefault string
		wantWarn    bool
	}{
		{"no cap leaves default", "30d", "", "30d", false},
		{"under cap untouched", "1d", "7d", "1d", false},
		{"at cap untouched", "7d", "7d", "7d", false},
		{"over cap clamped", "30d", "7d", "7d", true},
		{"never clamped by finite cap", "never", "7d", "7d", true},
		{"never cap allows never", "never", "never", "never", false},
		{"unknown default clamped (would store never)", "99y", "7d", "7d", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clearConfigEnv(t)
			t.Setenv("DEFAULT_EXPIRY", tt.defaultExp)
			if tt.maxExpiry != "" {
				t.Setenv("MAX_EXPIRY", tt.maxExpiry)
			}
			cfg, warnings, err := loadAndValidate(t)
			if err != nil {
				t.Fatalf("Validate: %v", err)
			}
			if cfg.DefaultExpiry != tt.wantDefault {
				t.Errorf("DefaultExpiry = %q, want %q", cfg.DefaultExpiry, tt.wantDefault)
			}
			if got := hasWarning(warnings, "DEFAULT_EXPIRY"); got != tt.wantWarn {
				t.Errorf("DEFAULT_EXPIRY warning present = %v, want %v (warnings %v)", got, tt.wantWarn, warnings)
			}
		})
	}
}

func TestValidate_BaseURL(t *testing.T) {
	tests := []struct {
		name     string
		value    string
		wantKept string
		wantWarn bool
	}{
		{"empty ok", "", "", false},
		{"https kept", "https://drop.example.com", "https://drop.example.com", false},
		{"http kept", "http://drop.example.com:3000", "http://drop.example.com:3000", false},
		{"no scheme ignored", "drop.example.com", "", true},
		{"wrong scheme ignored", "ftp://drop.example.com", "", true},
		{"relative path ignored", "/drop", "", true},
		{"garbage ignored", "http://", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clearConfigEnv(t)
			if tt.value != "" {
				t.Setenv("BASE_URL", tt.value)
			}
			cfg, warnings, err := loadAndValidate(t)
			if err != nil {
				t.Fatalf("Validate: %v", err)
			}
			if cfg.BaseURL != tt.wantKept {
				t.Errorf("BaseURL = %q, want %q", cfg.BaseURL, tt.wantKept)
			}
			if got := hasWarning(warnings, "BASE_URL"); got != tt.wantWarn {
				t.Errorf("BASE_URL warning present = %v, want %v (warnings %v)", got, tt.wantWarn, warnings)
			}
		})
	}
}

func TestValidate_ShortUploadPasswordWarns(t *testing.T) {
	tests := []struct {
		name     string
		password string
		wantWarn bool
	}{
		{"unset -> no warning", "", false},
		{"short -> warning", "s3cret", true},
		{"eight chars -> no warning", "s3cret42", false},
		{"long -> no warning", "a-much-longer-secret", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clearConfigEnv(t)
			if tt.password != "" {
				t.Setenv("UPLOAD_PASSWORD", tt.password)
			}
			_, warnings, err := loadAndValidate(t)
			if err != nil {
				t.Fatalf("Validate: %v", err)
			}
			if got := hasWarning(warnings, "UPLOAD_PASSWORD"); got != tt.wantWarn {
				t.Errorf("UPLOAD_PASSWORD warning present = %v, want %v (warnings %v)", got, tt.wantWarn, warnings)
			}
			// The warning must never include the secret itself.
			for _, warning := range warnings {
				if tt.password != "" && strings.Contains(warning, tt.password) {
					t.Errorf("warning leaked the password: %q", warning)
				}
			}
		})
	}
}

// hasWarning reports whether any warning mentions the given variable name.
func hasWarning(warnings []string, variable string) bool {
	for _, w := range warnings {
		if strings.Contains(w, variable) {
			return true
		}
	}
	return false
}
