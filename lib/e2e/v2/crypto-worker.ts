// The page's crypto worker. Vite bundles the worker into the main chunk as a
// string and starts it from a blob: URL, so the integrity hash that pins the
// main chunk covers the worker too and no worker file is ever fetched.

import CryptoWorker from "./worker?worker&inline";
import { connect, type Client, type Port } from "./protocol";

let client: Client | null = null;

/** Starts the worker on the first request, so a page that never opens or seals a format 4 share does without it. */
export const cryptoWorker: Client = {
  request(req, transfer) {
    client ??= connect(new CryptoWorker() as unknown as Port);
    return client.request(req, transfer);
  },
};
