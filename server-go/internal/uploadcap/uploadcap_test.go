package uploadcap

import (
	"strings"
	"testing"
	"time"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newCap(limit int64) (*Cap, *fakeClock) {
	clock := &fakeClock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	return New(limit, clock.now), clock
}

func TestCap_AllowsUpToTheLimit(t *testing.T) {
	c, _ := newCap(100)

	if _, _, ok := c.Take("203.0.113.7", 60); !ok {
		t.Fatal("first 60 bytes refused")
	}
	if _, _, ok := c.Take("203.0.113.7", 40); !ok {
		t.Fatal("bytes up to the limit refused")
	}
	_, wait, ok := c.Take("203.0.113.7", 1)
	if ok {
		t.Fatal("a byte past the limit was allowed")
	}
	if wait != Window {
		t.Errorf("retry after = %v, want %v", wait, Window)
	}
}

func TestCap_WindowRolls(t *testing.T) {
	c, clock := newCap(100)

	c.Take("203.0.113.7", 60)
	clock.advance(time.Hour)
	c.Take("203.0.113.7", 40)

	_, wait, ok := c.Take("203.0.113.7", 10)
	if ok {
		t.Fatal("allowed before any upload left the window")
	}
	if want := 23 * time.Hour; wait != want {
		t.Errorf("retry after = %v, want %v, when the first upload leaves the window", wait, want)
	}

	clock.advance(23 * time.Hour)
	if _, _, ok := c.Take("203.0.113.7", 60); !ok {
		t.Error("the first upload's bytes did not come free after 24 hours")
	}
}

func TestCap_UploadLargerThanTheLimit(t *testing.T) {
	c, _ := newCap(100)

	_, wait, ok := c.Take("203.0.113.7", 101)
	if ok {
		t.Fatal("an upload larger than the limit was allowed")
	}
	if wait != 0 {
		t.Errorf("retry after = %v, want 0 since waiting cannot help", wait)
	}
}

func TestCap_ReleaseGivesTheBytesBack(t *testing.T) {
	c, _ := newCap(100)

	release, _, ok := c.Take("203.0.113.7", 100)
	if !ok {
		t.Fatal("first upload refused")
	}
	release()
	if _, _, ok := c.Take("203.0.113.7", 100); !ok {
		t.Error("released bytes still count")
	}
}

func TestCap_ClientsAreSeparate(t *testing.T) {
	c, _ := newCap(100)

	c.Take("203.0.113.7", 100)
	if _, _, ok := c.Take("198.51.100.2", 100); !ok {
		t.Error("another client was charged for the first one's upload")
	}
}

func TestCap_IPv6CountsPerSlash64(t *testing.T) {
	c, _ := newCap(100)

	c.Take("2001:db8:0:1::1", 100)
	if _, _, ok := c.Take("2001:db8:0:1:ffff::2", 1); ok {
		t.Error("a second address in the same /64 got its own budget")
	}
	if _, _, ok := c.Take("2001:db8:0:2::1", 100); !ok {
		t.Error("a different /64 shared the budget")
	}
}

func TestCap_ForgetsIdleClients(t *testing.T) {
	c, clock := newCap(100)

	c.Take("203.0.113.7", 10)
	c.Take("198.51.100.2", 10)
	clock.advance(Window + sweepInterval)
	c.Take("192.0.2.1", 10)

	if got := len(c.clients); got != 1 {
		t.Errorf("clients held = %d, want 1 once the others left the window", got)
	}
}

func TestCap_KeepsNoAddress(t *testing.T) {
	c, _ := newCap(100)
	other, _ := newCap(100)

	c.Take("203.0.113.7", 10)
	other.Take("203.0.113.7", 10)

	for key := range c.clients {
		if strings.Contains(key, "203.0.113.7") {
			t.Errorf("client key %q holds the address", key)
		}
		if _, same := other.clients[key]; same {
			t.Error("two processes derive the same key for an address")
		}
	}
}
