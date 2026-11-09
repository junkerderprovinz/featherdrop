package share

// MaxEncMetaBytes caps the encrypted metadata the header endpoint serves. A
// manifest of thousands of file names stays well below it.
const MaxEncMetaBytes = 1 << 20

// BlobHeaderPeekBytes is enough of a blob's start to hold the length varint
// of any enc_meta up to MaxEncMetaBytes.
const BlobHeaderPeekBytes = 4

// BlobHeaderLength reads the start of a format 2 or 3 blob,
// [varint(metaLen)][enc_meta][content], as written by lib/e2e/blob-layout.ts.
// It returns the length of the varint plus enc_meta, so the encrypted file
// names can be served without a single content byte. It fails for a truncated
// varint, a length over MaxEncMetaBytes and a header that does not fit in size.
func BlobHeaderLength(prefix []byte, size int64) (int64, bool) {
	var metaLen int64
	for i, b := range prefix {
		if i >= BlobHeaderPeekBytes {
			return 0, false
		}
		metaLen |= int64(b&0x7f) << (7 * i)
		if b&0x80 != 0 {
			continue
		}
		total := int64(i+1) + metaLen
		if metaLen > MaxEncMetaBytes || total > size {
			return 0, false
		}
		return total, true
	}
	return 0, false
}
