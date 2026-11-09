// Package uploadcap enforces UPLOAD_LIMIT_PER_IP, the bytes one client may
// upload in a rolling window. Clients are known only by an HMAC of their
// address under a key drawn at startup, so the counts never hold an address and
// cannot be matched across restarts. Nothing is stored on disk or logged.
package uploadcap

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"sync"
	"time"

	"github.com/junkerderprovinz/castleparcel/server-go/internal/clientip"
)

// Window is how long an upload counts against its client.
const Window = 24 * time.Hour

// sweepInterval bounds how often Take drops clients whose uploads have all left
// the window.
const sweepInterval = time.Hour

type grant struct {
	id    uint64
	at    time.Time
	bytes int64
}

// Cap counts upload bytes per client, safe for concurrent use. Build one with
// New.
type Cap struct {
	mu        sync.Mutex
	limit     int64
	key       []byte
	clients   map[string][]grant
	nextID    uint64
	now       func() time.Time
	lastSweep time.Time
}

// New allows each client limit bytes per Window. A nil now means time.Now.
func New(limit int64, now func() time.Time) *Cap {
	if now == nil {
		now = time.Now
	}
	return &Cap{
		limit:     limit,
		key:       []byte(rand.Text()),
		clients:   make(map[string][]grant),
		now:       now,
		lastSweep: now(),
	}
}

// Take charges n bytes to the client at ip. When that would pass the limit it
// returns ok false and how long until enough bytes come free, or 0 when n
// alone is over the limit. release hands the bytes back, for an upload that
// was refused after all.
func (c *Cap) Take(ip string, n int64) (release func(), retryAfter time.Duration, ok bool) {
	if n > c.limit {
		return nil, 0, false
	}
	key := c.clientKey(ip)

	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.now()
	c.sweepLocked(now)
	grants := live(c.clients[key], now)

	var used int64
	for _, g := range grants {
		used += g.bytes
	}
	if over := used + n - c.limit; over > 0 {
		var freed int64
		for _, g := range grants {
			freed += g.bytes
			if freed >= over {
				return nil, g.at.Add(Window).Sub(now), false
			}
		}
	}

	c.nextID++
	id := c.nextID
	c.clients[key] = append(grants, grant{id: id, at: now, bytes: n})
	return func() { c.release(key, id) }, 0, true
}

func (c *Cap) release(key string, id uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	grants := c.clients[key]
	for i, g := range grants {
		if g.id == id {
			c.clients[key] = append(grants[:i], grants[i+1:]...)
			return
		}
	}
}

// clientKey is the HMAC of the client's network (see clientip.Network).
func (c *Cap) clientKey(ip string) string {
	mac := hmac.New(sha256.New, c.key)
	mac.Write([]byte(clientip.Network(ip)))
	return string(mac.Sum(nil))
}

// live drops the grants that have left the window. Grants are kept in the
// order they were taken, so the expired ones are a prefix.
func live(grants []grant, now time.Time) []grant {
	for i, g := range grants {
		if now.Sub(g.at) < Window {
			return grants[i:]
		}
	}
	return nil
}

// sweepLocked drops clients with no grant left in the window. The caller holds
// c.mu.
func (c *Cap) sweepLocked(now time.Time) {
	if now.Sub(c.lastSweep) < sweepInterval {
		return
	}
	c.lastSweep = now
	for key, grants := range c.clients {
		if len(live(grants, now)) == 0 {
			delete(c.clients, key)
		}
	}
}
