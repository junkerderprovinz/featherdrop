package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/junkerderprovinz/castleparcel/server-go/internal/share"
)

// VerifierCheck is the outcome of CheckKeyVerifier.
type VerifierCheck int

const (
	VerifierOK VerifierCheck = iota
	VerifierWrong
	// VerifierLocked means the share refuses every verifier, right or wrong,
	// until its lock runs out.
	VerifierLocked
	VerifierNoShare
)

// CheckKeyVerifier compares provided with the verifier stored for slug and
// keeps the share's run of wrong ones, locking it as share.VerifierLock says.
// The run lives in the row, so a restart does not reset it, and the
// transaction makes parallel guesses queue for the lock instead of slipping
// past it. retryAfter is set for VerifierLocked.
func CheckKeyVerifier(db *sql.DB, slug, provided string, nowMs int64) (result VerifierCheck, retryAfter time.Duration, err error) {
	tx, err := db.Begin()
	if err != nil {
		return VerifierNoShare, 0, fmt.Errorf("check key verifier: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var (
		stored      sql.NullString
		failures    int64
		lockedUntil sql.NullInt64
	)
	err = tx.QueryRow(
		`SELECT key_verifier, verifier_failures, verifier_locked_until FROM files WHERE slug = ?`,
		slug,
	).Scan(&stored, &failures, &lockedUntil)
	if errors.Is(err, sql.ErrNoRows) {
		return VerifierNoShare, 0, nil
	}
	if err != nil {
		return VerifierNoShare, 0, fmt.Errorf("check key verifier: select: %w", err)
	}

	if lockedUntil.Valid && lockedUntil.Int64 > nowMs {
		return VerifierLocked, time.Duration(lockedUntil.Int64-nowMs) * time.Millisecond, nil
	}

	if share.VerifierMatches(provided, stored.String) {
		if failures == 0 && !lockedUntil.Valid {
			return VerifierOK, 0, nil
		}
		if _, err := tx.Exec(
			`UPDATE files SET verifier_failures = 0, verifier_locked_until = NULL WHERE slug = ?`,
			slug,
		); err != nil {
			return VerifierNoShare, 0, fmt.Errorf("check key verifier: reset: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return VerifierNoShare, 0, fmt.Errorf("check key verifier: commit: %w", err)
		}
		return VerifierOK, 0, nil
	}

	failures++
	var until any
	if lock := share.VerifierLock(failures); lock > 0 {
		until = nowMs + lock.Milliseconds()
	}
	if _, err := tx.Exec(
		`UPDATE files SET verifier_failures = ?, verifier_locked_until = ? WHERE slug = ?`,
		failures, until, slug,
	); err != nil {
		return VerifierNoShare, 0, fmt.Errorf("check key verifier: count: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return VerifierNoShare, 0, fmt.Errorf("check key verifier: commit: %w", err)
	}
	return VerifierWrong, 0, nil
}
