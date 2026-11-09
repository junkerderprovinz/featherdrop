// The crypto worker for tests: the protocol handler runs on one end of a
// MessageChannel and the client on the other, so every message is cloned or
// transferred as it would be across a Web Worker boundary.
import { after } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { serve, connect, type Client, type Port } from "../lib/e2e/v2/protocol";

const channels: MessageChannel[] = [];
after(() => {
  for (const ch of channels) {
    ch.port1.close();
    ch.port2.close();
  }
});

export function cryptoWorker(): Client {
  const ch = new MessageChannel();
  channels.push(ch);
  serve(ch.port1 as unknown as Port);
  return connect(ch.port2 as unknown as Port);
}
