package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// wantColumns lists every column the files table must have after ApplySchema,
// mirroring server/schema.ts (base + additive migrations).
var wantColumns = []string{
	// base table
	"id", "slug", "original_name", "size", "mime", "password_hash",
	"expires_at", "created_at", "download_count",
	// additive migrations
	"encrypted", "enc_mode", "enc_key_wrapped",
	"max_downloads",
	"format", "wrapped_key", "kdf_salt",
	"key_verifier",
	"manage_token_hash",
}

func tableColumns(t *testing.T, db *sql.DB) map[string]struct{} {
	t.Helper()
	cols, err := fileColumns(db)
	if err != nil {
		t.Fatalf("fileColumns: %v", err)
	}
	return cols
}

func assertAllColumns(t *testing.T, db *sql.DB) {
	t.Helper()
	cols := tableColumns(t, db)
	for _, name := range wantColumns {
		if _, ok := cols[name]; !ok {
			t.Errorf("missing column %q", name)
		}
	}
}

func assertIndexExists(t *testing.T, db *sql.DB) {
	t.Helper()
	var name string
	err := db.QueryRow(
		"SELECT name FROM sqlite_master WHERE type='index' AND name=?",
		"idx_files_expires_at",
	).Scan(&name)
	if err != nil {
		t.Fatalf("index idx_files_expires_at not found: %v", err)
	}
	if name != "idx_files_expires_at" {
		t.Errorf("index name = %q, want idx_files_expires_at", name)
	}
}

func TestOpenAppliesSchemaIdempotently(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "db.sqlite")

	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	// ApplySchema a second time must be a no-op (idempotent).
	if err := ApplySchema(db); err != nil {
		t.Fatalf("second ApplySchema: %v", err)
	}

	assertAllColumns(t, db)
	assertIndexExists(t, db)
}

func TestApplySchemaUpgradesOldDatabase(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "db.sqlite")

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer db.Close()

	// Create only the legacy base table (pre-encryption), then upgrade.
	if _, err := db.Exec(`
		CREATE TABLE files (
			id             TEXT PRIMARY KEY,
			slug           TEXT UNIQUE NOT NULL,
			original_name  TEXT NOT NULL,
			size           INTEGER NOT NULL,
			mime           TEXT,
			password_hash  TEXT,
			expires_at     INTEGER,
			created_at     INTEGER NOT NULL,
			download_count INTEGER NOT NULL DEFAULT 0
		);
	`); err != nil {
		t.Fatalf("create legacy table: %v", err)
	}

	// Insert a legacy row to prove the additive migration preserves data.
	if _, err := db.Exec(
		`INSERT INTO files (id, slug, original_name, size, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
		"id1", "slug1", "name.bin", 123, 1000,
	); err != nil {
		t.Fatalf("insert legacy row: %v", err)
	}

	if err := ApplySchema(db); err != nil {
		t.Fatalf("ApplySchema on old DB: %v", err)
	}

	assertAllColumns(t, db)
	assertIndexExists(t, db)

	// The legacy row survives and new columns take their defaults.
	var (
		slug      string
		encrypted int
		format    int
	)
	if err := db.QueryRow(
		"SELECT slug, encrypted, format FROM files WHERE id=?", "id1",
	).Scan(&slug, &encrypted, &format); err != nil {
		t.Fatalf("read upgraded row: %v", err)
	}
	if slug != "slug1" {
		t.Errorf("slug = %q, want slug1", slug)
	}
	if encrypted != 0 {
		t.Errorf("encrypted default = %d, want 0", encrypted)
	}
	if format != 1 {
		t.Errorf("format default = %d, want 1", format)
	}
}
