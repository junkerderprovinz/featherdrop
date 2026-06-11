import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { TMP_DIR, UPLOADS_DIR } from "../lib/config";
import { deleteFileRecord, listExpired } from "./db";

const INTERVAL_MS = 5 * 60 * 1000; // sweep every 5 minutes

// Abandoned tus uploads (blob + .json sidecar in TMP_DIR) older than this are
// deleted. 24h leaves generous room to resume an interrupted upload while
// keeping abandoned ones from leaking disk forever. mtime advances with every
// written chunk, so an upload that is still making progress is never swept.
const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

/** Delete files whose expiry has passed, then drop their metadata rows. */
export async function sweepExpired(now = Date.now()): Promise<number> {
  const expired = listExpired(now);
  for (const rec of expired) {
    try {
      // force:true means a missing blob does NOT throw — only a real failure
      // (EACCES, EBUSY, …) lands in the catch.
      await rm(join(UPLOADS_DIR, rec.id), { force: true });
    } catch (err) {
      // Real deletion failure: keep the DB row so the next sweep retries.
      // Dropping the row now would orphan the blob on disk forever.
      // eslint-disable-next-line no-console
      console.error(`cleanup: could not delete blob ${rec.id}`, err);
      continue;
    }
    deleteFileRecord(rec.id);
  }
  return expired.length;
}

/**
 * Delete abandoned tus upload artifacts (blob + .json sidecar) from TMP_DIR.
 * tus never cleans up uploads that were started but never finalized, so
 * anything older than TMP_MAX_AGE_MS is treated as abandoned and removed.
 */
export async function sweepTmp(now = Date.now()): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(TMP_DIR);
  } catch {
    return 0; // TMP_DIR not created yet — nothing to sweep
  }
  let removed = 0;
  for (const name of entries) {
    const path = join(TMP_DIR, name);
    try {
      const s = await stat(path);
      if (!s.isFile() || now - s.mtimeMs < TMP_MAX_AGE_MS) continue;
      await rm(path, { force: true });
      removed++;
    } catch {
      // Entry vanished mid-sweep or is unreadable — skip; the next sweep retries.
    }
  }
  return removed;
}

/** Start the periodic cleanup loop. Runs once immediately, then on an interval. */
export function startCleanup(): void {
  if (timer) return;
  const run = () => {
    void sweepExpired().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("cleanup sweep failed", err);
    });
    void sweepTmp().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("tmp sweep failed", err);
    });
  };
  run();
  timer = setInterval(run, INTERVAL_MS);
  // Do not keep the event loop alive solely for the sweep.
  timer.unref?.();
}
