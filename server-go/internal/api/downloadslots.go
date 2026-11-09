package api

import (
	"database/sql"
	"sync"

	"github.com/junkerderprovinz/featherdrop/server-go/internal/store"
)

type slotState int

const (
	slotTaken slotState = iota
	// slotBusy means the share has downloads left, but each of them is
	// already streaming to someone.
	slotBusy
	slotGone
)

// downloadSlots counts a download only once it has been delivered. Until then
// it is held here in memory, so a limited share never streams to more readers
// than it has downloads left, and a crash mid-stream leaves nothing counted.
type downloadSlots struct {
	db *sql.DB
	// mu also covers the database calls: acquire reads the count and finish
	// raises it, and if the in-flight number changed in between, two readers
	// could both see the last download as free.
	mu       sync.Mutex
	inFlight map[string]int64
}

func newDownloadSlots(db *sql.DB) *downloadSlots {
	return &downloadSlots{db: db, inFlight: make(map[string]int64)}
}

// acquire reserves one download of slug. Every slotTaken must be followed by
// exactly one finish.
func (s *downloadSlots) acquire(slug string) (slotState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rec, err := store.GetFileBySlug(s.db, slug)
	if err != nil {
		return slotGone, err
	}
	if rec == nil {
		return slotGone, nil
	}
	if rec.MaxDownloads != nil {
		if rec.DownloadCount >= *rec.MaxDownloads {
			return slotGone, nil
		}
		if rec.DownloadCount+s.inFlight[slug] >= *rec.MaxDownloads {
			return slotBusy, nil
		}
	}
	s.inFlight[slug]++
	return slotTaken, nil
}

// finish releases a reservation and counts it when the download was
// delivered. The result says whether that used up the share.
func (s *downloadSlots) finish(slug string, delivered bool) (store.DownloadResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.inFlight[slug] <= 1 {
		delete(s.inFlight, slug)
	} else {
		s.inFlight[slug]--
	}
	if !delivered {
		return store.DownloadResult{}, nil
	}
	return store.RegisterDownload(s.db, slug)
}
