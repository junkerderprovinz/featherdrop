package store

import (
	"database/sql"
	"errors"
	"fmt"
)

// FileRecord is one row of the files table. Nullable columns are pointers and
// blob columns are nil for NULL.
type FileRecord struct {
	ID            string // file name under UploadsDir
	Slug          string // public share identifier
	OriginalName  string
	Size          int64
	Mime          *string
	PasswordHash  *string
	ExpiresAt     *int64 // unix ms, nil for never
	CreatedAt     int64  // unix ms
	DownloadCount int64
	MaxDownloads  *int64 // nil for unlimited

	// Server-side encryption of format 1 rows.
	Encrypted     int64   // 1 for age-encrypted
	EncMode       *string // "link", "password" or nil
	EncKeyWrapped *string

	Format     int64  // 1 server-encrypted, 2 single file, 3 multi-file, 4 v2 container
	WrappedKey []byte // password mode: content key wrapped with the Argon2id KEK
	KDFSalt    []byte // password mode: 16-byte Argon2id salt
	// KeyVerifier is base64url(SHA-256(content key)); nil for uploads made
	// before verifiers existed.
	KeyVerifier *string
	// ManageTokenHash is base64url(SHA-256(manage token)); nil for a share
	// without a management link.
	ManageTokenHash *string
}

// download_count is left out and defaults to 0.
const insertSQL = `INSERT INTO files
	(id, slug, original_name, size, mime, password_hash, expires_at,
	 created_at, max_downloads, encrypted, enc_mode, enc_key_wrapped,
	 format, wrapped_key, kdf_salt, key_verifier, manage_token_hash)
 VALUES
	(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

// selectAllSQL lists the columns in the order scanFileRecord expects.
const selectAllSQL = `SELECT
	id, slug, original_name, size, mime, password_hash, expires_at,
	created_at, download_count, max_downloads, encrypted, enc_mode,
	enc_key_wrapped, format, wrapped_key, kdf_salt, key_verifier,
	manage_token_hash
 FROM files`

// CreateFileRecord inserts a new share row and stops counting the pending
// upload it was made from, in one transaction, so its bytes count toward the
// quota once throughout.
func CreateFileRecord(db *sql.DB, rec FileRecord) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("create file record: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(insertSQL,
		rec.ID,
		rec.Slug,
		rec.OriginalName,
		rec.Size,
		rec.Mime,
		rec.PasswordHash,
		rec.ExpiresAt,
		rec.CreatedAt,
		rec.MaxDownloads,
		rec.Encrypted,
		rec.EncMode,
		rec.EncKeyWrapped,
		rec.Format,
		nullableBlob(rec.WrappedKey),
		nullableBlob(rec.KDFSalt),
		rec.KeyVerifier,
		rec.ManageTokenHash,
	); err != nil {
		return fmt.Errorf("create file record: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM pending_uploads WHERE id = ?`, rec.ID); err != nil {
		return fmt.Errorf("create file record: pending: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("create file record: commit: %w", err)
	}
	return nil
}

// GetFileBySlug returns the share row for slug, or nil when there is none.
func GetFileBySlug(db *sql.DB, slug string) (*FileRecord, error) {
	row := db.QueryRow(selectAllSQL+" WHERE slug = ?", slug)
	rec, err := scanFileRecord(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get file by slug: %w", err)
	}
	return rec, nil
}

// DeleteFileBySlug deletes a share row, and with it its resume tokens, and
// returns its file id so the caller can remove the blob. ok is false when there
// was no such row.
func DeleteFileBySlug(db *sql.DB, slug string) (id string, ok bool, err error) {
	tx, err := db.Begin()
	if err != nil {
		return "", false, fmt.Errorf("delete file by slug: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	err = tx.QueryRow(`SELECT id FROM files WHERE slug = ?`, slug).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		if err := tx.Commit(); err != nil {
			return "", false, fmt.Errorf("delete file by slug: commit: %w", err)
		}
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("delete file by slug: select: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM files WHERE slug = ?`, slug); err != nil {
		return "", false, fmt.Errorf("delete file by slug: delete: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return "", false, fmt.Errorf("delete file by slug: commit: %w", err)
	}
	return id, true, nil
}

// ListExpired returns the rows whose expiry is at or before nowMs.
func ListExpired(db *sql.DB, nowMs int64) ([]FileRecord, error) {
	rows, err := db.Query(
		selectAllSQL+" WHERE expires_at IS NOT NULL AND expires_at <= ?",
		nowMs,
	)
	if err != nil {
		return nil, fmt.Errorf("list expired: %w", err)
	}
	defer rows.Close()

	var out []FileRecord
	for rows.Next() {
		rec, err := scanFileRecord(rows)
		if err != nil {
			return nil, fmt.Errorf("list expired: scan: %w", err)
		}
		out = append(out, *rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list expired: iterate: %w", err)
	}
	return out, nil
}

// rowScanner is satisfied by both *sql.Row and *sql.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanFileRecord(s rowScanner) (*FileRecord, error) {
	var rec FileRecord
	if err := s.Scan(
		&rec.ID,
		&rec.Slug,
		&rec.OriginalName,
		&rec.Size,
		&rec.Mime,
		&rec.PasswordHash,
		&rec.ExpiresAt,
		&rec.CreatedAt,
		&rec.DownloadCount,
		&rec.MaxDownloads,
		&rec.Encrypted,
		&rec.EncMode,
		&rec.EncKeyWrapped,
		&rec.Format,
		&rec.WrappedKey,
		&rec.KDFSalt,
		&rec.KeyVerifier,
		&rec.ManageTokenHash,
	); err != nil {
		return nil, err
	}
	return &rec, nil
}

// nullableBlob turns a nil slice into an untyped nil so the driver stores NULL
// rather than a zero-length BLOB.
func nullableBlob(b []byte) any {
	if b == nil {
		return nil
	}
	return b
}
