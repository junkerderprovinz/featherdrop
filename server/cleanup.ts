import { rm } from "node:fs/promises";
import { join } from "node:path";
import { UPLOADS_DIR } from "../lib/config";
import { deleteFileRecord, listExpired } from "./db";

const INTERVAL_MS = 5 * 60 * 1000; // sweep every 5 minutes

let timer: NodeJS.Timeout | null = null;

/** Delete files whose expiry has passed, then drop their metadata rows. */
export async function sweepExpired(now = Date.now()): Promise<number> {
  const expired = listExpired(now);
  for (const rec of expired) {
    try {
      await rm(join(UPLOADS_DIR, rec.id), { force: true });
    } catch {
      // If the file is already gone, still remove the row below.
    }
    deleteFileRecord(rec.id);
  }
  return expired.length;
}

/** Start the periodic cleanup loop. Runs once immediately, then on an interval. */
export function startCleanup(): void {
  if (timer) return;
  const run = () => {
    void sweepExpired().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("cleanup sweep failed", err);
    });
  };
  run();
  timer = setInterval(run, INTERVAL_MS);
  // Do not keep the event loop alive solely for the sweep.
  timer.unref?.();
}
