package store

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/share"
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

	Format     int64  // 1 server-encrypted, 2 single file, 3 multi-file
	WrappedKey []byte // password mode: content key wrapped with the Argon2id KEK
	KDFSalt    []byte // password mode: 16-byte Argon2id salt
	// KeyVerifier is base64url(SHA-256(content key)); nil for uploads made
	// before verifiers existed.
	KeyVerifier *string
	// ManageTokenHash stays in the schema for existing databases; new rows
	// leave it NULL.
	ManageTokenHash *string
}

// DownloadResult is the outcome of RegisterDownload.
type DownloadResult struct {
	Allowed  bool   // false when the share is gone or its limit was reached
	Burned   bool   // this was the last allowed download and the row is deleted
	RecordID string // file to remove from disk when Burned
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

// CreateFileRecord inserts a new share row.
func CreateFileRecord(db *sql.DB, rec FileRecord) error {
	_, err := db.Exec(insertSQL,
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
	)
	if err != nil {
		return fmt.Errorf("create file record: %w", err)
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

// RegisterDownload counts one download against a share's limit. The count and,
// on the last allowed download, the delete run in one transaction, so
// concurrent downloads can never exceed the limit. The caller removes the blob
// when the result is Burned.
func RegisterDownload(db *sql.DB, slug string) (DownloadResult, error) {
	tx, err := db.Begin()
	if err != nil {
		return DownloadResult{}, fmt.Errorf("register download: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.Exec(
		`UPDATE files SET download_count = download_count + 1
		 WHERE slug = ? AND (max_downloads IS NULL OR download_count < max_downloads)`,
		slug,
	)
	if err != nil {
		return DownloadResult{}, fmt.Errorf("register download: update: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return DownloadResult{}, fmt.Errorf("register download: rows affected: %w", err)
	}
	if affected == 0 {
		if err := tx.Commit(); err != nil {
			return DownloadResult{}, fmt.Errorf("register download: commit: %w", err)
		}
		return DownloadResult{Allowed: false, Burned: false, RecordID: ""}, nil
	}

	var (
		id           string
		count        int64
		maxDownloads *int64
	)
	err = tx.QueryRow(
		`SELECT id, download_count, max_downloads FROM files WHERE slug = ?`,
		slug,
	).Scan(&id, &count, &maxDownloads)
	if err != nil {
		return DownloadResult{}, fmt.Errorf("register download: reselect: %w", err)
	}

	burned := share.IsExhausted(count, maxDownloads)
	if burned {
		if _, err := tx.Exec(`DELETE FROM files WHERE slug = ?`, slug); err != nil {
			return DownloadResult{}, fmt.Errorf("register download: delete: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return DownloadResult{}, fmt.Errorf("register download: commit: %w", err)
	}
	return DownloadResult{Allowed: true, Burned: burned, RecordID: id}, nil
}

// DeleteFileBySlug deletes a share row and returns its file id so the caller
// can remove the blob. ok is false when there was no such row.
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

// TotalStoredSize returns the sum of all share sizes in bytes, for
// STORAGE_QUOTA. It is not cached: the table has one row per live share, and a
// cache would need invalidating on every finalize, burn and expiry.
func TotalStoredSize(db *sql.DB) (int64, error) {
	var total int64
	if err := db.QueryRow(`SELECT COALESCE(SUM(size), 0) FROM files`).Scan(&total); err != nil {
		return 0, fmt.Errorf("total stored size: %w", err)
	}
	return total, nil
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
