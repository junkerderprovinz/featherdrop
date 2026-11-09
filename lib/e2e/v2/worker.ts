// Entry of the crypto Web Worker, loaded with
// new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }).

import { serve, type Port } from "./protocol";

serve(self as unknown as Port);
