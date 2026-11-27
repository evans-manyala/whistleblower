import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { transaction, verifyCaseHistory } from "./case-history.mjs";
import { PendingBitcoinConfirmation, checkProofDigest, readCheckpoint, saveCheckpoint, stampCheckpoint, upgradeCheckpoint, verifyBitcoinAnchor } from "./checkpoints.mjs";
import { HttpError } from "./http.mjs";
import { openTenantDatabase, organisationDirectory } from "./tenants.mjs";

const minute = 60_000;
const hour = 60 * minute;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function checkpointDirectory(root, org) {
  const archive = resolve(process.env.WHISTLEBLOWER_ARCHIVE_DIR || join(root, "archive"));
  return join(organisationDirectory(archive, org), "checkpoints");
}

function checkpointName(entries) { return `auto-${entries}.json`; }

function history(root, org, checkpoint) {
  const db = openTenantDatabase(root, org);
  try { return verifyCaseHistory(db, checkpoint, org.log_id); }
  finally { db.close(); }
}

async function proofBytes(file) {
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > 1024 * 1024) throw new Error("Invalid proof file.");
    return await fd.readFile();
  } finally { await fd.close(); }
}

export function anchorStatus(db, org) {
  const scan = db.prepare("SELECT checked_at, failed FROM anchor_scans WHERE org=?").get(org.id);
  const latest = db.prepare("SELECT entries,phase,created_at,next_at,failed FROM anchor_jobs WHERE org=? ORDER BY entries DESC LIMIT 1").get(org.id);
  const verified = db.prepare("SELECT entries,block,verified_at FROM anchor_jobs WHERE org=? AND phase='verified' ORDER BY entries DESC LIMIT 1").get(org.id);
  return {
    state: scan?.failed ? "check_failed" : latest?.failed ? "retrying" : latest?.phase ?? "waiting",
    phase: latest?.phase ?? null, entries: latest?.entries ?? null, createdAt: latest?.created_at ?? null,
    checkedAt: scan?.checked_at ?? null, retryAt: latest && latest.phase !== "verified" ? latest.next_at : null,
    verified: verified ? { entries: verified.entries, block: verified.block, at: verified.verified_at } : null,
  };
}

export async function verifiedArtifact(db, root, org, entries, receipt) {
  const job = db.prepare("SELECT manifest,receipt_hash FROM anchor_jobs WHERE org=? AND entries=? AND phase='verified'").get(org.id, entries);
  if (!job) throw new HttpError(404, "That verified checkpoint is unavailable.");
  const name = checkpointName(entries) + (receipt ? ".ots" : "");
  try {
    const saved = JSON.parse(job.manifest);
    if (saved.logId !== org.log_id || saved.entries !== entries) throw new Error("Wrong checkpoint.");
    const bytes = await proofBytes(join(checkpointDirectory(root, org), name));
    const expected = receipt ? job.receipt_hash : hash(job.manifest + "\n");
    if (hash(bytes) !== expected) throw new Error("Artifact has changed.");
    return { name: org.slug + "-" + name, bytes };
  } catch {
    throw new HttpError(409, "The archived file could not be authenticated. Contact the platform operator.");
  }
}

export async function runAnchorSweep(db, root, { now = Date.now } = {}) {
  db.exec("INSERT OR IGNORE INTO anchor_scans(org) SELECT id FROM organisations WHERE active=1");
  const due = db.prepare(`SELECT o.*, s.next_at FROM organisations o JOIN anchor_scans s ON s.org=o.id
    WHERE o.active=1 AND s.lease_until<=? AND (s.next_at<=? OR EXISTS
      (SELECT 1 FROM anchor_jobs j WHERE j.org=o.id AND j.phase!='verified' AND j.next_at<=?))
    ORDER BY s.next_at, o.id`).all(now(), now(), now());

  async function processOrganisation(org) {
    const token = randomUUID();
    const start = now();
    const owned = () => db.prepare("SELECT next_at FROM anchor_scans JOIN organisations ON id=org WHERE org=? AND active=1 AND lease=?").get(org.id, token);
    if (!db.prepare("UPDATE anchor_scans SET lease=?,lease_until=? WHERE org=? AND lease_until<=? AND EXISTS (SELECT 1 FROM organisations WHERE id=? AND active=1)")
      .run(token, start + 10 * minute, org.id, start, org.id).changes) return;

    // Only the current lease holder can publish state after asynchronous calendar calls.
    function publish(write) {
      return transaction(db, () => {
        if (!owned()) return false;
        write();
        return true;
      });
    }
    try {
      if (owned()?.next_at <= start) {
        try {
          const previous = db.prepare("SELECT manifest FROM anchor_jobs WHERE org=? ORDER BY entries DESC LIMIT 1").get(org.id);
          const checkpoint = history(root, org, previous && JSON.parse(previous.manifest));
          publish(() => {
            if (checkpoint.entries) db.prepare(`INSERT OR IGNORE INTO anchor_jobs
              (org,entries,manifest,created_at,next_at,phase) VALUES (?,?,?,?,?,'queued')`)
              .run(org.id, checkpoint.entries, JSON.stringify(checkpoint), start, start);
            db.prepare("UPDATE anchor_scans SET checked_at=?,next_at=?,failed=0 WHERE org=?")
              .run(start, start + (checkpoint.entries ? hour : minute), org.id);
          });
        } catch (error) {
          console.error("Bitcoin checkpoint scan failed", org.id, error.code || error.name);
          publish(() => db.prepare("UPDATE anchor_scans SET checked_at=?,next_at=?,failed=1 WHERE org=?").run(start, start + 15 * minute, org.id));
        }
      }
      const job = db.prepare("SELECT * FROM anchor_jobs WHERE org=? AND phase!='verified' AND next_at<=? ORDER BY next_at,entries LIMIT 1").get(org.id, now());
      if (!job || !owned()) return;
      const file = join(checkpointDirectory(root, org), checkpointName(job.entries));
      const change = (phase, delay, failed = 0) => publish(() => db.prepare("UPDATE anchor_jobs SET phase=?,failed=?,next_at=? WHERE org=? AND entries=?")
        .run(phase, failed, now() + delay, org.id, job.entries));
      let phase = job.phase;
      try {
        const saved = JSON.parse(job.manifest);
        history(root, org, saved);
        if (phase === "queued" && !existsSync(file)) await saveCheckpoint(file, saved);
        const { digest, contents } = await readCheckpoint(file);
        if (digest !== hash(job.manifest + "\n")) throw new Error("Archived checkpoint differs from scheduled history.");
        if (phase === "queued") {
          // A crash after publishing the receipt can leave this job queued. Reuse that file.
          if (existsSync(file + ".ots")) await checkProofDigest(file + ".ots", digest);
          else await stampCheckpoint(file, digest, contents);
          change("pending", 15 * minute);
          return;
        }
        if (phase === "pending") {
          await upgradeCheckpoint(file, digest);
          phase = "verifying";
          if (!change(phase, 0)) return;
        }
        const receiptHash = hash(await proofBytes(file + ".ots"));
        const block = Number(await verifyBitcoinAnchor(file, digest));
        if (!Number.isSafeInteger(block) || block < 1 || receiptHash !== hash(await proofBytes(file + ".ots"))) {
          throw new Error("Bitcoin block or receipt could not be verified.");
        }
        history(root, org, saved);
        publish(() => db.prepare(`UPDATE anchor_jobs SET phase='verified',failed=0,block=?,verified_at=?,receipt_hash=?
          WHERE org=? AND entries=?`).run(block, now(), receiptHash, org.id, job.entries));
      } catch (error) {
        const pending = error instanceof PendingBitcoinConfirmation;
        if (!pending && !job.failed) console.error("Bitcoin anchoring will retry", org.id, phase, error.code || error.name);
        change(phase, 15 * minute, pending ? 0 : 1);
      }
    } finally {
      db.prepare("UPDATE anchor_scans SET lease=NULL,lease_until=0 WHERE org=? AND lease=?").run(org.id, token);
    }
  }

  for (let offset = 0; offset < due.length; offset += 4) {
    await Promise.all(due.slice(offset, offset + 4).map(processOrganisation));
  }
}
