package store

import (
	"database/sql"
	"errors"
	"fmt"
)

// PendingUpload is a tus upload that has been created but is not yet a share
// or a request upload. Its declared length counts toward STORAGE_QUOTA from
// the create on, so uploads nobody finishes cannot fill the disk past it.
type PendingUpload struct {
	ID          string
	Size        int64  // declared Upload-Length
	RequestSlug string // the request it was created for, "" for none
	CreatedAt   int64  // unix ms
}

// Reservation is the outcome of ReservePendingUpload.
type Reservation int

const (
	Reserved Reservation = iota
	OverQuota
	// NoFreePlace means every free place of the request already has an
	// upload in progress, or the request is gone.
	NoFreePlace
)

// The row is written before tusd creates the upload and removed in the same
// transaction that stores it, or once its files are gone, so it survives a
// restart. request_slug has no foreign key: an upload outlives a closed
// request until cleanup removes its bytes, and counts until then.
func applyPendingSchema(db *sql.DB) error {
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS pending_uploads (
			id           TEXT PRIMARY KEY,
			size         INTEGER NOT NULL,
			request_slug TEXT,
			created_at   INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_pending_uploads_request_slug ON pending_uploads (request_slug);
	`); err != nil {
		return fmt.Errorf("create pending uploads table: %w", err)
	}
	return nil
}

const quotaUsageSQL = `SELECT (SELECT COALESCE(SUM(size), 0) FROM files)
	+ (SELECT COALESCE(SUM(size), 0) FROM request_uploads)
	+ (SELECT COALESCE(SUM(size), 0) FROM pending_uploads WHERE id <> ?)`

// QuotaUsage returns the bytes that count toward STORAGE_QUOTA: every share
// and request upload, and the declared length of every pending upload but
// skip. It is not cached, since every create, finalize, burn and expiry would
// have to invalidate it.
func QuotaUsage(db *sql.DB, skip string) (int64, error) {
	var used int64
	if err := db.QueryRow(quotaUsageSQL, skip).Scan(&used); err != nil {
		return 0, fmt.Errorf("quota usage: %w", err)
	}
	return used, nil
}

// ReservePendingUpload records up unless its length would take QuotaUsage
// past quota, when quota is set, or up is for a request whose free places all
// have an upload in progress. Check and insert share one transaction, so
// parallel creates never pass either limit.
func ReservePendingUpload(db *sql.DB, up PendingUpload, quota int64) (Reservation, error) {
	tx, err := db.Begin()
	if err != nil {
		return 0, fmt.Errorf("reserve pending upload: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if quota > 0 {
		var used int64
		if err := tx.QueryRow(quotaUsageSQL, "").Scan(&used); err != nil {
			return 0, fmt.Errorf("reserve pending upload: usage: %w", err)
		}
		if used+up.Size > quota {
			return OverQuota, nil
		}
	}
	if up.RequestSlug != "" {
		var full bool
		err := tx.QueryRow(
			`SELECT max_uploads IS NOT NULL AND upload_count +
			   (SELECT COUNT(*) FROM pending_uploads WHERE request_slug = slug) >= max_uploads
			 FROM requests WHERE slug = ?`,
			up.RequestSlug,
		).Scan(&full)
		if errors.Is(err, sql.ErrNoRows) {
			return NoFreePlace, nil
		}
		if err != nil {
			return 0, fmt.Errorf("reserve pending upload: places: %w", err)
		}
		if full {
			return NoFreePlace, nil
		}
	}
	if _, err := tx.Exec(
		`INSERT INTO pending_uploads (id, size, request_slug, created_at) VALUES (?, ?, ?, ?)`,
		up.ID, up.Size, nullableString(up.RequestSlug), up.CreatedAt,
	); err != nil {
		return 0, fmt.Errorf("reserve pending upload: insert: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("reserve pending upload: commit: %w", err)
	}
	return Reserved, nil
}

// TrackPendingUpload records up without any check, unless its id is already
// known. It is for uploads found on disk that have no row.
func TrackPendingUpload(db *sql.DB, up PendingUpload) error {
	if _, err := db.Exec(
		`INSERT OR IGNORE INTO pending_uploads (id, size, request_slug, created_at) VALUES (?, ?, ?, ?)`,
		up.ID, up.Size, nullableString(up.RequestSlug), up.CreatedAt,
	); err != nil {
		return fmt.Errorf("track pending upload: %w", err)
	}
	return nil
}

// GetPendingUpload returns the pending upload id, or nil when there is none.
func GetPendingUpload(db *sql.DB, id string) (*PendingUpload, error) {
	up := PendingUpload{ID: id}
	var slug sql.NullString
	err := db.QueryRow(
		`SELECT size, request_slug, created_at FROM pending_uploads WHERE id = ?`, id,
	).Scan(&up.Size, &slug, &up.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get pending upload: %w", err)
	}
	up.RequestSlug = slug.String
	return &up, nil
}

// ListPendingUploads returns the ids of the pending uploads created at or
// before cutoffMs, oldest first.
func ListPendingUploads(db *sql.DB, cutoffMs int64) ([]string, error) {
	rows, err := db.Query(`SELECT id FROM pending_uploads WHERE created_at <= ? ORDER BY created_at`, cutoffMs)
	if err != nil {
		return nil, fmt.Errorf("list pending uploads: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("list pending uploads: scan: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list pending uploads: iterate: %w", err)
	}
	return ids, nil
}

// PendingRequestUploads returns the ids of the pending uploads started for a
// file request.
func PendingRequestUploads(db *sql.DB) (map[string]bool, error) {
	rows, err := db.Query(`SELECT id FROM pending_uploads WHERE request_slug IS NOT NULL`)
	if err != nil {
		return nil, fmt.Errorf("list pending request uploads: %w", err)
	}
	defer rows.Close()
	ids := make(map[string]bool)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("list pending request uploads: scan: %w", err)
		}
		ids[id] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list pending request uploads: iterate: %w", err)
	}
	return ids, nil
}

// DeletePendingUpload stops counting the pending upload id.
func DeletePendingUpload(db *sql.DB, id string) error {
	if _, err := db.Exec(`DELETE FROM pending_uploads WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete pending upload: %w", err)
	}
	return nil
}

// nullableString stores an empty s as NULL.
func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}
