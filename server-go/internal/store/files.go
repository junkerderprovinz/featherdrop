package store

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/share"
)

// FileRecord mirrors the FileRecord interface in server/db.ts column-for-column.
// Nullable columns use pointers (*T) so a Go nil round-trips to/from SQL NULL,
// matching the TypeScript `T | null` fields; blob columns are []byte (nil =
// NULL). Non-nullable columns are plain values.
type FileRecord struct {
	ID            string // stored filename under UploadsDir
	Slug          string // public share identifier
	OriginalName  string
	Size          int64
	Mime          *string // null = unknown (zero-knowledge uploads)
	PasswordHash  *string // null = no server-side password (always null in v2)
	ExpiresAt     *int64  // unix ms, null = never
	CreatedAt     int64   // unix ms
	DownloadCount int64
	MaxDownloads  *int64 // null = unlimited; delete after this many
	// v1 at-rest encryption fields (legacy)
	Encrypted     int64   // 0 = plaintext blob, 1 = age-encrypted
	EncMode       *string // "link" | "password" | null
	EncKeyWrapped *string // password-wrapped per-file key (password mode)
	// Zero-knowledge v2 fields
	Format     int64  // 1 = legacy at-rest, 2 = ZK single file, 3 = ZK multi-file
	WrappedKey []byte // password mode: content key wrapped with Argon2id KEK
	KDFSalt    []byte // password mode: 16-byte Argon2id salt
	// format>=2 download authorization: base64url(SHA-256(content key)).
	KeyVerifier *string // null = legacy/no-verifier upload
	// Kept as a drop-in column for schema compatibility. The early-delete
	// management feature was removed (expiry handles removal), so finalize always
	// writes NULL here and nothing reads it.
	ManageTokenHash *string // always null for new rows
}

// DownloadResult mirrors server/db.ts DownloadResult.
type DownloadResult struct {
	Allowed  bool   // false = no such share, or its limit was already reached
	Burned   bool   // true = this was the final allowed download; row deleted
	RecordID string // stored filename to remove from disk when burned
}

// Store wraps the *sql.DB with the files-table query methods. The methods are
// also exposed as package functions taking a *sql.DB so callers holding the bare
// db (as main.go does) can use either form.
type Store struct {
	DB *sql.DB
}

// New wraps an already-opened *sql.DB.
func New(db *sql.DB) *Store { return &Store{DB: db} }

// fileColumnsList is the canonical INSERT column order, mirroring the column
// list in server/db.ts createFileRecord (download_count omitted: it defaults 0).
const insertSQL = `INSERT INTO files
	(id, slug, original_name, size, mime, password_hash, expires_at,
	 created_at, max_downloads, encrypted, enc_mode, enc_key_wrapped,
	 format, wrapped_key, kdf_salt, key_verifier, manage_token_hash)
 VALUES
	(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

// selectAllSQL selects every column in a fixed order so Scan stays aligned.
const selectAllSQL = `SELECT
	id, slug, original_name, size, mime, password_hash, expires_at,
	created_at, download_count, max_downloads, encrypted, enc_mode,
	enc_key_wrapped, format, wrapped_key, kdf_salt, key_verifier,
	manage_token_hash
 FROM files`

// CreateFileRecord inserts a new share row. download_count defaults to 0 (not in
// the column list). Mirrors server/db.ts createFileRecord.
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

// CreateFileRecord is the method form of the package function.
func (s *Store) CreateFileRecord(rec FileRecord) error {
	return CreateFileRecord(s.DB, rec)
}

// GetFileBySlug returns the share row for slug, or (nil, nil) when no such row
// exists. Mirrors server/db.ts getFileBySlug (undefined -> nil).
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

// GetFileBySlug is the method form of the package function.
func (s *Store) GetFileBySlug(slug string) (*FileRecord, error) {
	return GetFileBySlug(s.DB, slug)
}

// RegisterDownload atomically registers one download against a share's limit.
// It bumps download_count only while still under max_downloads (NULL =
// unlimited) and — when that was the last allowed download — deletes the row in
// the SAME transaction, so concurrent downloads of a limited share can never
// exceed the limit. The caller removes the blob from disk when Burned. Mirrors
// server/db.ts registerDownload EXACTLY.
func RegisterDownload(db *sql.DB, slug string) (DownloadResult, error) {
	tx, err := db.Begin()
	if err != nil {
		return DownloadResult{}, fmt.Errorf("register download: begin: %w", err)
	}
	// Roll back on any early return; a no-op after a successful Commit.
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
		// No such share, or its limit was already reached. Commit the (empty)
		// transaction so it closes cleanly.
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

// RegisterDownload is the method form of the package function.
func (s *Store) RegisterDownload(slug string) (DownloadResult, error) {
	return RegisterDownload(s.DB, slug)
}

// DeleteFileBySlug atomically deletes a share row by slug, returning its stored
// file id so the caller can remove the blob. ok is false when no such row exists
// (already gone / unknown slug). Mirrors server/db.ts deleteFileBySlug
// (null -> ok=false). Used by the uploader's "delete early" route.
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

// DeleteFileBySlug is the method form of the package function.
func (s *Store) DeleteFileBySlug(slug string) (string, bool, error) {
	return DeleteFileBySlug(s.DB, slug)
}

// ListExpired returns the rows whose expiry has passed (expires_at not null and
// <= nowMs). Mirrors server/db.ts listExpired.
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

// ListExpired is the method form of the package function.
func (s *Store) ListExpired(nowMs int64) ([]FileRecord, error) {
	return ListExpired(s.DB, nowMs)
}

// rowScanner is satisfied by both *sql.Row and *sql.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

// scanFileRecord scans one row in selectAllSQL's column order into a FileRecord.
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

// nullableBlob returns nil for an empty/absent blob so it stores as SQL NULL
// (an empty, non-nil []byte would otherwise store as a zero-length BLOB, not
// NULL — matching the TS Buffer|null contract).
func nullableBlob(b []byte) any {
	if b == nil {
		return nil
	}
	return b
}
