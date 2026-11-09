// Entry of the crypto Web Worker, started by ./crypto-worker.ts.

import { serve, type Port } from "./protocol";

serve(self as unknown as Port);
