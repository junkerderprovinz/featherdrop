import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { tusServer } from "./server/tus";
import { initDb } from "./server/db";
import { startCleanup } from "./server/cleanup";

// Custom Node server so the tus upload handler and the Next.js app share one
// process and one port. Everything under /files is raw tus; everything else is
// handled by Next (pages + API routes).
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? "0.0.0.0";
const dev = process.env.NODE_ENV !== "production";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

async function main(): Promise<void> {
  await app.prepare();
  initDb();
  startCleanup();

  createServer((req, res) => {
    // Route the tus endpoint (/files create, /files/<id> patch) to tus. Match an
    // exact "/files", a "/files/" sub-path, or "/files?…" query — so we never
    // hijack an unrelated Next route that merely starts with "files".
    const url = req.url ?? "/";
    if (url === "/files" || url.startsWith("/files/") || url.startsWith("/files?")) {
      tusServer.handle(req, res);
      return;
    }
    handle(req, res, parse(url, true));
  }).listen(port, hostname, () => {
    // eslint-disable-next-line no-console
    console.log(`featherdrop listening on http://${hostname}:${port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal: failed to start server", err);
  process.exit(1);
});
