// Entry of the crypto Web Worker, started by ./crypto-worker.ts.

import { serve } from "./serve";
import type { Port } from "./protocol";

serve(self as unknown as Port);
