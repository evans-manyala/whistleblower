import { workerData } from "node:worker_threads";
import { runBackupSweep } from "../lib/scheduled-backups.mjs";
import { openRegistry } from "../lib/tenants.mjs";

const db = openRegistry(workerData.root);
async function tick() {
  try { await runBackupSweep(db, workerData.root); }
  catch (error) { console.error("Backup worker failed", error.code || error.name); }
  setTimeout(tick, 60_000);
}
await tick();
