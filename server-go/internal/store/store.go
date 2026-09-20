// Package store owns the SQLite metadata database. It uses modernc.org/sqlite,
// which needs no cgo, so the server builds as a static binary.
package store

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

// Open opens or creates the database at dbPath and applies the schema.
//
// SQLite allows one writer at a time, and without a busy timeout a second
// writer fails at once with "database is locked", which showed up as spurious
// 404s from RegisterDownload under overlapping downloads. WAL keeps readers
// from blocking the writer, busy_timeout makes a contending writer wait, and a
// single pooled connection serializes the writes.
func Open(dbPath string) (*sql.DB, error) {
	dsn := "file:" + dbPath +
		"?_pragma=busy_timeout(5000)" +
		"&_pragma=journal_mode(WAL)" +
		"&_pragma=foreign_keys(on)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite %q: %w", dbPath, err)
	}
	db.SetMaxOpenConns(1)
	if err := ApplySchema(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// ApplySchema creates the files table and index and adds each later column
// when it is missing, so it is safe to run on every start and on old databases.
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

	migrations := []struct{ name, ddl string }{
		{"encrypted", "encrypted INTEGER NOT NULL DEFAULT 0"},
		{"enc_mode", "enc_mode TEXT"},
		{"enc_key_wrapped", "enc_key_wrapped TEXT"},
		{"max_downloads", "max_downloads INTEGER"},
		// Rows from before browser encryption are format 1.
		{"format", "format INTEGER NOT NULL DEFAULT 1"},
		{"wrapped_key", "wrapped_key BLOB"},
		{"kdf_salt", "kdf_salt BLOB"},
		{"key_verifier", "key_verifier TEXT"},
		{"manage_token_hash", "manage_token_hash TEXT"},
	}
	for _, m := range migrations {
		if err := addColumn(m.name, m.ddl); err != nil {
			return err
		}
	}
	return nil
}

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
