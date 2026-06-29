package config

import (
	"os"
	"path/filepath"
	"testing"
)

// configEnvVars are all the environment variables Load reads.
var configEnvVars = []string{
	"DATA_DIR", "CONFIG_DIR", "MAX_FILE_SIZE", "DEFAULT_EXPIRY", "BASE_URL",
	"UPLOAD_PASSWORD", "APP_NAME", "APP_LOGO", "ACCENT_COLOR", "PORT",
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
