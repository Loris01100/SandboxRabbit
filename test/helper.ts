/**
 * Un fil auxiliaire du moteur sous Node (`worker_threads`), pour test/pool.ts :
 * le pendant du rôle auxiliaire de src/client/sim/worker.ts. Tout le travail
 * est dans `serve()`.
 */
import { parentPort } from "node:worker_threads";
import { serve } from "../src/client/sim/pool.ts";

parentPort!.on("message", (message) => serve(message, (ready) => parentPort!.postMessage(ready)));
