import { workerData } from "node:worker_threads";
import { runAnchorSweep } from "../lib/anchors.mjs";
import { openRegistry } from "../lib/tenants.mjs";

const db = openRegistry(workerData.root);
async function tick() {
  try { await runAnchorSweep(db, workerData.root); }
  catch (error) { console.error("Bitcoin anchoring sweep failed", error.code || error.name); }
  setTimeout(tick, 60_000);
}
await tick();
