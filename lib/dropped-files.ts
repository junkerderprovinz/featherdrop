// Read files straight from the drop / file-picker event instead of letting
// react-dropzone walk the DataTransferItemList via webkitGetAsEntry(). That
// directory-traversal path crashes Chromium/Edge renderers on some setups with
// RESULT_CODE_KILLED_BAD_MESSAGE (featherdrop #4; also uppy#4133 and the
// Nextcloud 30 regression). The file picker and Firefox never take that path,
// which is exactly why they were unaffected. We return the whole flat FileList
// (one or many files); no directory traversal — folders are never expanded.
export function filesFromDropEvent(event: unknown): File[] {
  const e = event as {
    dataTransfer?: { files?: ArrayLike<File> | null } | null;
    target?: { files?: ArrayLike<File> | null } | null;
  };
  const dropped = e?.dataTransfer?.files;
  if (dropped && dropped.length > 0) return Array.from(dropped);
  const picked = e?.target?.files;
  if (picked && picked.length > 0) return Array.from(picked);
  return [];
}
