// Package cleanup deletes expired shares and abandoned tus uploads, so their
// bytes leave the disk and stop counting toward STORAGE_QUOTA.
package cleanup

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/config"
	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
)

const (
	// Interval is how often Run sweeps after the pass at startup.
	Interval = 5 * time.Minute
	// StaleUploadAge is how long a tus upload may go untouched before it
	// counts as abandoned.
	StaleUploadAge = 24 * time.Hour
)

// Result counts what one Sweep removed.
type Result struct {
	Shares  int
	Uploads int
}

// Run sweeps once right away and then every interval until ctx is done. It
// logs a line only for a pass that removed something, and only counts, since
// slugs are secret links.
func Run(ctx context.Context, cfg config.Config, db *sql.DB, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		res, err := Sweep(cfg, db, time.Now())
		if err != nil {
			log.Printf("cleanup: %v", err)
		}
		if res.Shares > 0 || res.Uploads > 0 {
			log.Printf("cleanup: removed %d expired shares, %d stale uploads", res.Shares, res.Uploads)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Sweep deletes the shares expired at now and the tus uploads untouched for
// StaleUploadAge. A failure in one half does not stop the other.
func Sweep(cfg config.Config, db *sql.DB, now time.Time) (Result, error) {
	shares, sharesErr := deleteExpiredShares(cfg.UploadsDir, db, now.UnixMilli())
	uploads, uploadsErr := removeStaleUploads(cfg.TmpDir, now.Add(-StaleUploadAge))
	return Result{Shares: shares, Uploads: uploads}, errors.Join(sharesErr, uploadsErr)
}

// deleteExpiredShares removes each blob before its row. A download that has
// the blob open still streams it whole, one that comes later finds no blob and
// answers 404, and a crash in between leaves only a row for the next pass. A
// blob that cannot be removed keeps its row, so the quota still counts it.
func deleteExpiredShares(uploadsDir string, db *sql.DB, nowMs int64) (int, error) {
	expired, err := store.ListExpired(db, nowMs)
	if err != nil {
		return 0, err
	}
	deleted, stuck := 0, 0
	for _, rec := range expired {
		err := os.Remove(filepath.Join(uploadsDir, rec.ID))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			stuck++
			continue
		}
		// ok is false when a burning download deleted the row first.
		_, ok, err := store.DeleteFileBySlug(db, rec.Slug)
		if err != nil {
			return deleted, err
		}
		if ok {
			deleted++
		}
	}
	if stuck > 0 {
		return deleted, fmt.Errorf("kept %d expired shares whose blobs could not be removed", stuck)
	}
	return deleted, nil
}

// removeStaleUploads removes the tus uploads in tmpDir last modified at or
// before cutoff. tusd writes the .info sidecar at creation and appends every
// PATCH to the bytes, so the newer of the two files tells when the upload was
// last active, and one still in progress never looks stale.
func removeStaleUploads(tmpDir string, cutoff time.Time) (int, error) {
	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		return 0, fmt.Errorf("read tmp dir: %w", err)
	}
	lastActive := make(map[string]time.Time)
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue
		}
		// A finalize can move the file away between ReadDir and Info.
		info, err := e.Info()
		if err != nil {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".info")
		if t := info.ModTime(); t.After(lastActive[id]) {
			lastActive[id] = t
		}
	}

	removed, stuck := 0, 0
	for id, t := range lastActive {
		if t.After(cutoff) {
			continue
		}
		gone := false
		for _, name := range []string{id, id + ".info"} {
			err := os.Remove(filepath.Join(tmpDir, name))
			switch {
			case err == nil:
				gone = true
			case !errors.Is(err, fs.ErrNotExist):
				stuck++
			}
		}
		if gone {
			removed++
		}
	}
	if stuck > 0 {
		return removed, fmt.Errorf("could not remove %d stale upload files", stuck)
	}
	return removed, nil
}
