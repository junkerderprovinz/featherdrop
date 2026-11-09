// Package clientip finds the address a request comes from. X-Forwarded-For is
// read only when the connection comes from a proxy the operator trusts, since on
// a directly exposed server any client can write that header.
package clientip

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
)

// Proxies are the reverse proxies whose X-Forwarded-For is believed. The zero
// value trusts none.
type Proxies struct {
	all      bool
	prefixes []netip.Prefix
}

// Parse reads TRUST_PROXY: a boolean, where true trusts any peer, or a
// comma-separated list of addresses and CIDR ranges.
func Parse(value string) (Proxies, error) {
	if value == "" {
		return Proxies{}, nil
	}
	if all, err := strconv.ParseBool(value); err == nil {
		return Proxies{all: all}, nil
	}
	var p Proxies
	for entry := range strings.SplitSeq(value, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		prefix, err := parsePrefix(entry)
		if err != nil {
			return Proxies{}, fmt.Errorf("%q is neither an address nor a CIDR range", entry)
		}
		p.prefixes = append(p.prefixes, prefix)
	}
	if len(p.prefixes) == 0 {
		return Proxies{}, fmt.Errorf("the list holds no address")
	}
	return p, nil
}

func parsePrefix(entry string) (netip.Prefix, error) {
	if strings.Contains(entry, "/") {
		prefix, err := netip.ParsePrefix(entry)
		return prefix.Masked(), err
	}
	addr, err := netip.ParseAddr(entry)
	if err != nil {
		return netip.Prefix{}, err
	}
	addr = addr.Unmap()
	return netip.PrefixFrom(addr, addr.BitLen()), nil
}

func (p Proxies) trusts(addr netip.Addr) bool {
	if p.all {
		return true
	}
	for _, prefix := range p.prefixes {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

// ClientIP returns the connection peer, or when that peer is a trusted proxy,
// the nearest X-Forwarded-For entry that is not one. Each proxy appends the
// address it received from, so only entries written by a trusted proxy are
// believed; anything further left may be forged by the client.
func (p Proxies) ClientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	client := peer.Unmap()
	if !p.trusts(client) {
		return client.String()
	}
	entries := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(entries) - 1; i >= 0; i-- {
		addr, err := netip.ParseAddr(strings.TrimSpace(entries[i]))
		if err != nil {
			break
		}
		client = addr.Unmap()
		if !p.trusts(client) {
			break
		}
	}
	return client.String()
}
