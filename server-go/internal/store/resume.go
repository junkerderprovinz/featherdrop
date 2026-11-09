package store

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/junkerderprovinz/castleparcel/server-go/internal/share"
)

// DownloadStart is the outcome of StartDownload.
type DownloadStart int

const (
	DownloadStarted DownloadStart = iota
	// DownloadBusy means the share has no downloads left, but one of them can
	// still be resumed, so the share is not gone yet.
	DownloadBusy
	DownloadGone
)

// DownloadResult is the outcome of FinishDownload.
type DownloadResult struct {
	Burned   bool   // the last download of a used-up share is done and its row is deleted
	RecordID string // file to remove from disk when Burned
}

// StartDownload counts one download of slug and stores tokenHash as its resume
// token. The count is a conditional update in one transaction, so concurrent
// downloads never exceed the limit. A share that has used up its downloads
// stays until the last of its tokens is finished or runs out.
func StartDownload(db *sql.DB, slug, tokenHash string, nowMs int64) (DownloadStart, error) {
	tx, err := db.Begin()
	if err != nil {
		return DownloadGone, fmt.Errorf("start download: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.Exec(
		`UPDATE files SET download_count = download_count + 1
		 WHERE slug = ? AND (max_downloads IS NULL OR download_count < max_downloads)`,
		slug,
	)
	if err != nil {
		return DownloadGone, fmt.Errorf("start download: count: %w", err)
	}
	counted, err := res.RowsAffected()
	if err != nil {
		return DownloadGone, fmt.Errorf("start download: rows affected: %w", err)
	}
	if counted == 0 {
		var live int
		err := tx.QueryRow(
			`SELECT COUNT(*) FROM resumes r JOIN files f ON f.id = r.file_id
			 WHERE f.slug = ? AND r.until > ?`,
			slug, nowMs,
		).Scan(&live)
		if err != nil {
			return DownloadGone, fmt.Errorf("start download: live resumes: %w", err)
		}
		if live > 0 {
			return DownloadBusy, nil
		}
		return DownloadGone, nil
	}

	if _, err := tx.Exec(
		`INSERT INTO resumes (token_hash, file_id, until, deadline)
		 SELECT ?, id, ?, ? FROM files WHERE slug = ?`,
		tokenHash, nowMs+share.ResumeIdle.Milliseconds(), nowMs+share.ResumeLifetime.Milliseconds(), slug,
	); err != nil {
		return DownloadGone, fmt.Errorf("start download: token: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return DownloadGone, fmt.Errorf("start download: commit: %w", err)
	}
	return DownloadStarted, nil
}

// ResumeDownload reports whether tokenHash is a live resume token of slug and,
// if so, gives it another ResumeIdle, never past its lifetime.
func ResumeDownload(db *sql.DB, slug, tokenHash string, nowMs int64) (bool, error) {
	res, err := db.Exec(
		`UPDATE resumes SET until = MIN(?, deadline)
		 WHERE token_hash = ? AND until > ?
		   AND file_id = (SELECT id FROM files WHERE slug = ?)`,
		nowMs+share.ResumeIdle.Milliseconds(), tokenHash, nowMs, slug,
	)
	if err != nil {
		return false, fmt.Errorf("resume download: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("resume download: rows affected: %w", err)
	}
	return n == 1, nil
}

// KeepResumable gives a live token another ResumeIdle from nowMs, never past
// its lifetime. A token that has run out stays out.
func KeepResumable(db *sql.DB, tokenHash string, nowMs int64) error {
	if _, err := db.Exec(
		`UPDATE resumes SET until = MIN(?, deadline) WHERE token_hash = ? AND until > ?`,
		nowMs+share.ResumeIdle.Milliseconds(), tokenHash, nowMs,
	); err != nil {
		return fmt.Errorf("keep resumable: %w", err)
	}
	return nil
}

// FinishDownload retires tokenHash once its download has reached the last
// byte. When that was the last token of a share with no downloads left, the
// row goes in the same transaction and the caller removes the blob.
func FinishDownload(db *sql.DB, tokenHash string) (DownloadResult, error) {
	tx, err := db.Begin()
	if err != nil {
		return DownloadResult{}, fmt.Errorf("finish download: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var id string
	err = tx.QueryRow(`SELECT file_id FROM resumes WHERE token_hash = ?`, tokenHash).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return DownloadResult{}, nil
	}
	if err != nil {
		return DownloadResult{}, fmt.Errorf("finish download: select: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM resumes WHERE token_hash = ?`, tokenHash); err != nil {
		return DownloadResult{}, fmt.Errorf("finish download: retire token: %w", err)
	}

	res, err := tx.Exec(
		`DELETE FROM files WHERE id = ?
		   AND max_downloads IS NOT NULL AND download_count >= max_downloads
		   AND NOT EXISTS (SELECT 1 FROM resumes WHERE file_id = ?)`,
		id, id,
	)
	if err != nil {
		return DownloadResult{}, fmt.Errorf("finish download: burn: %w", err)
	}
	burned, err := res.RowsAffected()
	if err != nil {
		return DownloadResult{}, fmt.Errorf("finish download: rows affected: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return DownloadResult{}, fmt.Errorf("finish download: commit: %w", err)
	}
	return DownloadResult{Burned: burned == 1, RecordID: id}, nil
}

// ListAbandoned returns the shares that have used up their downloads and have
// no live resume token left. Nothing can make such a share readable again, so
// the caller may remove its blob before its row.
func ListAbandoned(db *sql.DB, nowMs int64) ([]FileRecord, error) {
	rows, err := db.Query(
		selectAllSQL+` WHERE max_downloads IS NOT NULL AND download_count >= max_downloads
		   AND NOT EXISTS (SELECT 1 FROM resumes r WHERE r.file_id = files.id AND r.until > ?)`,
		nowMs,
	)
	if err != nil {
		return nil, fmt.Errorf("list abandoned: %w", err)
	}
	defer rows.Close()

	var out []FileRecord
	for rows.Next() {
		rec, err := scanFileRecord(rows)
		if err != nil {
			return nil, fmt.Errorf("list abandoned: scan: %w", err)
		}
		out = append(out, *rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list abandoned: iterate: %w", err)
	}
	return out, nil
}

// DeleteStaleResumes deletes the tokens that ran out at or before nowMs.
func DeleteStaleResumes(db *sql.DB, nowMs int64) (int64, error) {
	res, err := db.Exec(`DELETE FROM resumes WHERE until <= ?`, nowMs)
	if err != nil {
		return 0, fmt.Errorf("delete stale resumes: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("delete stale resumes: rows affected: %w", err)
	}
	return n, nil
}
