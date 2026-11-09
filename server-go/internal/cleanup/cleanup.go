// Package cleanup deletes expired shares, used-up shares with no download left
// to resume, expired file requests with their uploads, and abandoned tus
// uploads, so their bytes leave the disk and stop counting toward
// STORAGE_QUOTA.
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
	// StaleRequestUploadAge is the same for an upload to a file request. It
	// holds one of the request's few places while it runs, so a sender who
	// reloads mid-upload must not lock the request for a day.
	StaleRequestUploadAge = time.Hour
)

// Result counts what one Sweep removed.
type Result struct {
	Shares   int
	Requests int
	Uploads  int
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
		if res.Shares > 0 || res.Requests > 0 || res.Uploads > 0 {
			log.Printf("cleanup: removed %d shares, %d requests, %d stale uploads", res.Shares, res.Requests, res.Uploads)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Sweep deletes the shares expired at now, the used-up shares whose resume
// tokens have all run out, the requests expired at now with their uploads, and
// the tus uploads untouched for StaleUploadAge, or StaleRequestUploadAge for
// one sent to a file request. A failure in one part does not
// stop the others.
func Sweep(cfg config.Config, db *sql.DB, now time.Time) (Result, error) {
	shares, sharesErr := deleteShares(cfg.UploadsDir, db, now.UnixMilli())
	requests, requestsErr := deleteRequests(cfg.UploadsDir, db, now.UnixMilli())
	uploads, uploadsErr := removeStaleUploads(cfg.TmpDir, db, now)
	return Result{Shares: shares, Requests: requests, Uploads: uploads}, errors.Join(sharesErr, requestsErr, uploadsErr)
}

// deleteShares removes each blob before its row. A download that has the blob
// open still streams it whole, one that comes later finds no blob and answers
// 404, and a crash in between leaves only a row for the next pass. A blob that
// cannot be removed keeps its row, so the quota still counts it.
func deleteShares(uploadsDir string, db *sql.DB, nowMs int64) (int, error) {
	expired, err := store.ListExpired(db, nowMs)
	if err != nil {
		return 0, err
	}
	abandoned, err := store.ListAbandoned(db, nowMs)
	if err != nil {
		return 0, err
	}
	deleted, stuck := 0, 0
	for _, rec := range append(expired, abandoned...) {
		err := os.Remove(filepath.Join(uploadsDir, rec.ID))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			stuck++
			continue
		}
		// ok is false when a burning download, or the other list, deleted
		// the row first.
		_, ok, err := store.DeleteFileBySlug(db, rec.Slug)
		if err != nil {
			return deleted, err
		}
		if ok {
			deleted++
		}
	}
	if _, err := store.DeleteStaleResumes(db, nowMs); err != nil {
		return deleted, err
	}
	if stuck > 0 {
		return deleted, fmt.Errorf("kept %d shares whose blobs could not be removed", stuck)
	}
	return deleted, nil
}

// deleteRequests closes each expired request and removes the blobs of its
// uploads before its rows, as deleteShares does. A request with a blob that cannot be
// removed keeps its rows for the next pass.
func deleteRequests(uploadsDir string, db *sql.DB, nowMs int64) (int, error) {
	expired, err := store.ListExpiredRequests(db, nowMs)
	if err != nil {
		return 0, err
	}
	deleted, stuck := 0, 0
	for _, rec := range expired {
		// An attach that started before the expiry could otherwise land
		// between the listing and the delete and leave its blob behind.
		if err := store.CloseRequest(db, rec.Slug); err != nil {
			return deleted, err
		}
		ups, err := store.ListRequestUploads(db, rec.Slug)
		if err != nil {
			return deleted, err
		}
		removed := true
		for _, up := range ups {
			err := os.Remove(filepath.Join(uploadsDir, up.FileID))
			if err != nil && !errors.Is(err, fs.ErrNotExist) {
				removed = false
			}
		}
		if !removed {
			stuck++
			continue
		}
		ok, err := store.DeleteRequest(db, rec.Slug)
		if err != nil {
			return deleted, err
		}
		if ok {
			deleted++
		}
	}
	if stuck > 0 {
		return deleted, fmt.Errorf("kept %d requests whose uploads could not be removed", stuck)
	}
	return deleted, nil
}

// removeStaleUploads removes the tus uploads in tmpDir that have gone idle,
// and stops counting them toward the quota. tusd writes the
// .info sidecar at creation and appends every PATCH to the bytes, so the newer
// of the two files tells when the upload was last active, and one still in
// progress never looks stale.
func removeStaleUploads(tmpDir string, db *sql.DB, now time.Time) (int, error) {
	cutoff := now.Add(-StaleUploadAge)
	forRequest, err := store.PendingRequestUploads(db)
	if err != nil {
		return 0, err
	}
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
		idleSince := cutoff
		if forRequest[id] {
			idleSince = now.Add(-StaleRequestUploadAge)
		}
		if t.After(idleSince) {
			continue
		}
		gone, kept := false, false
		for _, name := range []string{id, id + ".info"} {
			err := os.Remove(filepath.Join(tmpDir, name))
			switch {
			case err == nil:
				gone = true
			case !errors.Is(err, fs.ErrNotExist):
				stuck++
				kept = true
			}
		}
		if gone {
			removed++
		}
		if !kept {
			delete(lastActive, id)
			if err := store.DeletePendingUpload(db, id); err != nil {
				return removed, err
			}
		}
	}

	// A row is written before tusd creates the files, so a younger row
	// without files may be a create in flight. An older one belongs to an
	// upload removed here, or lost to a crash or a failed finalize.
	pending, err := store.ListPendingUploads(db, cutoff.UnixMilli())
	if err != nil {
		return removed, err
	}
	for _, id := range pending {
		if _, ok := lastActive[id]; ok {
			continue
		}
		if err := store.DeletePendingUpload(db, id); err != nil {
			return removed, err
		}
	}
	if stuck > 0 {
		return removed, fmt.Errorf("could not remove %d stale upload files", stuck)
	}
	return removed, nil
}
