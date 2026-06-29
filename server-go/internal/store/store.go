// Package store owns the SQLite metadata database. It uses modernc.org/sqlite
// (pure Go, CGO-free) so the server builds as a static binary, and it mirrors
// the schema + additive migrations of the existing TypeScript server/schema.ts
// EXACTLY, so the Go binary opens the same db.sqlite as a drop-in replacement.
package store

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite" // registers the "sqlite" database/sql driver
)

// Open opens (creating if needed) the SQLite database at dbPath and applies the
// schema/migrations idempotently. The returned *sql.DB is ready to use.
//
// Concurrency: modernc.org/sqlite over database/sql opens a pool of connections,
// and SQLite allows only one writer at a time. Without a busy timeout the second
// concurrent writer fails immediately with "database is locked" — under
// overlapping downloads that surfaces as spurious 404s from RegisterDownload's
// write transaction. We therefore (a) enable WAL so readers never block the
// writer, (b) set a 5s busy_timeout so a contending writer waits instead of
// erroring, and (c) cap the pool at a single connection so writers serialize
// cleanly, matching the single-connection, serialized-write behaviour of the
// TypeScript server's better-sqlite3. foreign_keys is enabled for parity with
// the TS schema setup.
func Open(dbPath string) (*sql.DB, error) {
	dsn := "file:" + dbPath +
		"?_pragma=busy_timeout(5000)" +
		"&_pragma=journal_mode(WAL)" +
		"&_pragma=foreign_keys(on)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite %q: %w", dbPath, err)
	}
	// One connection => writers serialize instead of racing for the write lock.
	db.SetMaxOpenConns(1)
	if err := ApplySchema(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// ApplySchema creates the files table + index and applies the additive
// migrations. It is idempotent: every column is added only when missing (via
// PRAGMA table_info(files)), matching server/schema.ts.
func ApplySchema(db *sql.DB) error {
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS files (
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
		CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files (expires_at);
	`); err != nil {
		return fmt.Errorf("create files table: %w", err)
	}

	cols, err := fileColumns(db)
	if err != nil {
		return err
	}

	addColumn := func(name, ddl string) error {
		if _, ok := cols[name]; ok {
			return nil
		}
		if _, err := db.Exec("ALTER TABLE files ADD COLUMN " + ddl); err != nil {
			return fmt.Errorf("add column %s: %w", name, err)
		}
		return nil
	}

	// Encryption metadata (v2).
	migrations := []struct{ name, ddl string }{
		{"encrypted", "encrypted INTEGER NOT NULL DEFAULT 0"},
		{"enc_mode", "enc_mode TEXT"},
		{"enc_key_wrapped", "enc_key_wrapped TEXT"},

		// Optional download limit (v2.7). NULL = unlimited.
		{"max_downloads", "max_downloads INTEGER"},

		// Zero-knowledge v2 columns (Phase 7a). format: 1 = legacy at-rest,
		// 2 = zero-knowledge (browser-encrypted). Existing rows default to 1.
		{"format", "format INTEGER NOT NULL DEFAULT 1"},
		{"wrapped_key", "wrapped_key BLOB"},
		{"kdf_salt", "kdf_salt BLOB"},

		// format=2 download authorization (base64url(SHA-256(K))).
		{"key_verifier", "key_verifier TEXT"},

		// The uploader's "delete early" credential (one-way hash).
		{"manage_token_hash", "manage_token_hash TEXT"},
	}
	for _, m := range migrations {
		if err := addColumn(m.name, m.ddl); err != nil {
			return err
		}
	}
	return nil
}

// fileColumns returns the set of column names currently on the files table.
func fileColumns(db *sql.DB) (map[string]struct{}, error) {
	rows, err := db.Query("PRAGMA table_info(files)")
	if err != nil {
		return nil, fmt.Errorf("pragma table_info(files): %w", err)
	}
	defer rows.Close()

	cols := make(map[string]struct{})
	for rows.Next() {
		var (
			cid       int
			name      string
			typ       string
			notNull   int
			dfltValue sql.NullString
			pk        int
		)
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dfltValue, &pk); err != nil {
			return nil, fmt.Errorf("scan table_info: %w", err)
		}
		cols[name] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate table_info: %w", err)
	}
	return cols, nil
}
