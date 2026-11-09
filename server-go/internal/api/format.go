package api

import (
	"encoding/binary"
	"errors"
	"io"
	"os"
)

// Format 4 is the versioned container described in docs/encryption-format.md.
// The server reads only its plaintext prefix, to refuse bytes that no client
// could open; the kind, mode and sizes inside stay encrypted.
const (
	format4Version   = 0x02
	format4PrefixLen = 5
	// The nonce, a header padded to at least 1024 bytes and the tag.
	format4MinHeader = 24 + 1024 + 16
	format4MaxHeader = 16 << 20
	// Content is padded to at least 4096 bytes, each chunk adds a tag.
	format4MinContent = 4096 + 16
)

var errUnsupportedFormat = errors.New("unsupported format (this server is zero-knowledge only)")

// checkFormat validates the declared format against the request and the
// uploaded bytes at path. Formats 2 and 3 are opaque. Format 4 has no password
// wrap on the server, always carries a key verifier, and must start with a
// well-formed prefix.
func checkFormat(format int64, body finalizeBody, keyVerifier *string, path string, size int64) error {
	switch format {
	case 2, 3:
		return nil
	case 4:
	default:
		return errUnsupportedFormat
	}
	if keyVerifier == nil {
		return errors.New("format 4 requires a keyVerifier")
	}
	if body.WrappedKey != "" || body.KDFSalt != "" {
		return errors.New("format 4 takes no wrapped key")
	}
	return checkFormat4Blob(path, size)
}

// checkFormat4Blob reads the prefix of the format 4 blob of size bytes at
// path and fails unless it is well-formed.
func checkFormat4Blob(path string, size int64) error {
	f, err := os.Open(path)
	if err != nil {
		return errors.New("malformed format 4 blob")
	}
	defer f.Close()
	var prefix [format4PrefixLen]byte
	if _, err := io.ReadFull(f, prefix[:]); err != nil {
		return errors.New("malformed format 4 blob")
	}
	if _, ok := format4HeaderLength(prefix[:], size); !ok {
		return errors.New("malformed format 4 blob")
	}
	return nil
}

// format4HeaderLength reads the prefix of a format 4 blob of size bytes and
// returns the length of the prefix and the sealed header, where the content
// starts. It fails for another version, a header length out of range and a
// blob too short to hold the smallest padded content after the header.
func format4HeaderLength(prefix []byte, size int64) (int64, bool) {
	if len(prefix) < format4PrefixLen || prefix[0] != format4Version {
		return 0, false
	}
	headerLen := int64(binary.BigEndian.Uint32(prefix[1:format4PrefixLen]))
	if headerLen < format4MinHeader || headerLen > format4MaxHeader ||
		size-format4PrefixLen-headerLen < format4MinContent {
		return 0, false
	}
	return format4PrefixLen + headerLen, true
}
