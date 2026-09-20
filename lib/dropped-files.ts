// Reads files straight from the drop or picker event instead of letting
// react-dropzone walk the DataTransferItemList with webkitGetAsEntry(). That
// traversal crashes Chromium and Edge renderers on some setups with
// RESULT_CODE_KILLED_BAD_MESSAGE (featherdrop #4, uppy#4133). The flat FileList
// is returned and folders are never expanded.
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
