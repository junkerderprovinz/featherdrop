import { Server } from "@tus/server";
import { FileStore } from "@tus/file-store";
import { MAX_FILE_SIZE, TMP_DIR, ensureDataDirs } from "../lib/config";

// Resumable upload endpoint. tus handles the protocol (chunking, resume on
// connection drop); completed uploads land in TMP_DIR as `<id>` + `<id>.json`.
// The /api/finalize route then moves the file into the uploads dir and writes
// its metadata row. We deliberately keep tus unaware of expiry/password — those
// are chosen in the UI and submitted to finalize after the bytes are in.
ensureDataDirs();

export const tusServer = new Server({
  path: "/files",
  datastore: new FileStore({ directory: TMP_DIR }),
  // Only enforce a cap when one is configured; 0 = unlimited.
  ...(MAX_FILE_SIZE > 0 ? { maxSize: MAX_FILE_SIZE } : {}),
  // Slugs are issued by finalize, so the raw tus id can stay random/internal.
  respectForwardedHeaders: true,
});
