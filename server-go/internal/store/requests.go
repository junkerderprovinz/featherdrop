package store

import (
	"database/sql"
	"errors"
	"fmt"
)

// RequestRecord is one row of the requests table, a file request whose
// uploads only the holder of its collect link may read.
type RequestRecord struct {
	Slug string
	// PublicKey is the requester's X25519 public key in base64url. Uploads
	// are sealed to it, and uploaders prove they hold the request link by
	// sending it.
	PublicKey string
	// CollectTokenHash is base64url(SHA-256(collect token)).
	CollectTokenHash string
	ExpiresAt        *int64 // unix ms, nil for never
	CreatedAt        int64
	MaxUploads       *int64 // nil for unlimited
	MaxSize          *int64 // largest upload in bytes, nil for the server's limit
	UploadCount      int64
}

// Expired reports whether the request's expiry has passed at nowMs.
func (r RequestRecord) Expired(nowMs int64) bool {
	return r.ExpiresAt != nil && *r.ExpiresAt <= nowMs
}

// RequestUpload is one finished upload to a request.
type RequestUpload struct {
	ID        string // public id, unique within its request
	FileID    string // file name under UploadsDir
	Size      int64
	SealedKey []byte // the upload's link token sealed to the request's public key
	CreatedAt int64
}

func applyRequestSchema(db *sql.DB) error {
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS requests (
			slug               TEXT PRIMARY KEY,
			public_key         TEXT NOT NULL,
			collect_token_hash TEXT NOT NULL,
			expires_at         INTEGER,
			created_at         INTEGER NOT NULL,
			max_uploads        INTEGER,
			max_size           INTEGER,
			upload_count       INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_requests_expires_at ON requests (expires_at);
		CREATE TABLE IF NOT EXISTS request_uploads (
			request_slug TEXT NOT NULL REFERENCES requests (slug) ON DELETE CASCADE,
			id           TEXT NOT NULL,
			file_id      TEXT NOT NULL UNIQUE,
			size         INTEGER NOT NULL,
			sealed_key   BLOB NOT NULL,
			created_at   INTEGER NOT NULL,
			PRIMARY KEY (request_slug, id)
		);
	`); err != nil {
		return fmt.Errorf("create request tables: %w", err)
	}
	return nil
}

const selectRequestSQL = `SELECT slug, public_key, collect_token_hash, expires_at,
	created_at, max_uploads, max_size, upload_count FROM requests`

// CreateRequest inserts a new request.
func CreateRequest(db *sql.DB, rec RequestRecord) error {
	if _, err := db.Exec(
		`INSERT INTO requests (slug, public_key, collect_token_hash, expires_at, created_at, max_uploads, max_size)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		rec.Slug, rec.PublicKey, rec.CollectTokenHash, rec.ExpiresAt, rec.CreatedAt, rec.MaxUploads, rec.MaxSize,
	); err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	return nil
}

// GetRequest returns the request for slug, or nil when there is none.
func GetRequest(db *sql.DB, slug string) (*RequestRecord, error) {
	rec, err := scanRequest(db.QueryRow(selectRequestSQL+" WHERE slug = ?", slug))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get request: %w", err)
	}
	return rec, nil
}

// AddRequestUpload records a finished upload and counts it, unless the
// request is gone or has taken its maximum. The count and the insert share
// one transaction, so parallel uploads never pass the maximum.
func AddRequestUpload(db *sql.DB, slug string, up RequestUpload) (bool, error) {
	tx, err := db.Begin()
	if err != nil {
		return false, fmt.Errorf("add request upload: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.Exec(
		`UPDATE requests SET upload_count = upload_count + 1
		 WHERE slug = ? AND (max_uploads IS NULL OR upload_count < max_uploads)`,
		slug,
	)
	if err != nil {
		return false, fmt.Errorf("add request upload: count: %w", err)
	}
	counted, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("add request upload: rows affected: %w", err)
	}
	if counted == 0 {
		return false, nil
	}
	if _, err := tx.Exec(
		`INSERT INTO request_uploads (request_slug, id, file_id, size, sealed_key, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		slug, up.ID, up.FileID, up.Size, up.SealedKey, up.CreatedAt,
	); err != nil {
		return false, fmt.Errorf("add request upload: insert: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("add request upload: commit: %w", err)
	}
	return true, nil
}

// ListRequestUploads returns the uploads of a request, oldest first.
func ListRequestUploads(db *sql.DB, slug string) ([]RequestUpload, error) {
	rows, err := db.Query(
		`SELECT id, file_id, size, sealed_key, created_at FROM request_uploads
		 WHERE request_slug = ? ORDER BY created_at, rowid`,
		slug,
	)
	if err != nil {
		return nil, fmt.Errorf("list request uploads: %w", err)
	}
	defer rows.Close()
	var out []RequestUpload
	for rows.Next() {
		var up RequestUpload
		if err := rows.Scan(&up.ID, &up.FileID, &up.Size, &up.SealedKey, &up.CreatedAt); err != nil {
			return nil, fmt.Errorf("list request uploads: scan: %w", err)
		}
		out = append(out, up)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list request uploads: iterate: %w", err)
	}
	return out, nil
}

// GetRequestUpload returns the upload id of the request slug, or nil when the
// request has no such upload.
func GetRequestUpload(db *sql.DB, slug, id string) (*RequestUpload, error) {
	up := RequestUpload{ID: id}
	err := db.QueryRow(
		`SELECT file_id, size, sealed_key, created_at FROM request_uploads
		 WHERE request_slug = ? AND id = ?`,
		slug, id,
	).Scan(&up.FileID, &up.Size, &up.SealedKey, &up.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get request upload: %w", err)
	}
	return &up, nil
}

// DeleteRequest deletes a request and the rows of its uploads. ok is false
// when there was no such request. The caller removes the blobs first.
func DeleteRequest(db *sql.DB, slug string) (ok bool, err error) {
	res, err := db.Exec(`DELETE FROM requests WHERE slug = ?`, slug)
	if err != nil {
		return false, fmt.Errorf("delete request: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("delete request: rows affected: %w", err)
	}
	return n == 1, nil
}

// ListExpiredRequests returns the requests whose expiry is at or before nowMs.
func ListExpiredRequests(db *sql.DB, nowMs int64) ([]RequestRecord, error) {
	rows, err := db.Query(selectRequestSQL+" WHERE expires_at IS NOT NULL AND expires_at <= ?", nowMs)
	if err != nil {
		return nil, fmt.Errorf("list expired requests: %w", err)
	}
	defer rows.Close()
	var out []RequestRecord
	for rows.Next() {
		rec, err := scanRequest(rows)
		if err != nil {
			return nil, fmt.Errorf("list expired requests: scan: %w", err)
		}
		out = append(out, *rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list expired requests: iterate: %w", err)
	}
	return out, nil
}

func scanRequest(s rowScanner) (*RequestRecord, error) {
	var rec RequestRecord
	if err := s.Scan(&rec.Slug, &rec.PublicKey, &rec.CollectTokenHash, &rec.ExpiresAt,
		&rec.CreatedAt, &rec.MaxUploads, &rec.MaxSize, &rec.UploadCount); err != nil {
		return nil, err
	}
	return &rec, nil
}
