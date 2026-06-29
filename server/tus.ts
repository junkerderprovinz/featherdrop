import { Server } from "@tus/server";
import { FileStore } from "@tus/file-store";
import { MAX_FILE_SIZE, TMP_DIR, ensureDataDirs } from "../lib/config";
import {
  UPLOAD_TOKEN_HEADER,
  isUploadAuthorized,
} from "../lib/upload-auth";

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
  // Permit the upload-gate header on cross-origin preflight so a browser may
  // attach it (same-origin requests don't preflight; harmless either way).
  allowedHeaders: [UPLOAD_TOKEN_HEADER],
  // Optional upload gate (see lib/upload-auth.ts). When UPLOAD_PASSWORD is set,
  // every tus write request must carry a matching `x-fd-upload-token`. This hook
  // runs BEFORE the upload is created and BEFORE any bytes are written to the
  // datastore, so an unauthorized request stores nothing. Throwing an object
  // with `status_code`/`body` makes the tus error handler return that status —
  // a 401 here. Unset UPLOAD_PASSWORD → isUploadAuthorized is always true (open,
  // today's behaviour). The secret is never read into the message or logged.
  onIncomingRequest: async (req) => {
    if (!isUploadAuthorized(req.headers[UPLOAD_TOKEN_HEADER])) {
      throw { status_code: 401, body: "upload password required\n" };
    }
  },
});
