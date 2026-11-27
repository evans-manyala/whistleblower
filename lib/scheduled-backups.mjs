import { createHash, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { transaction } from "./case-history.mjs";
import { createBackupKey, createEncryptedBackup, createEncryptedRegistryBackup, readBackupKey, restoreEncryptedBackup, restoreEncryptedRegistryBackup } from "./backup.mjs";
import { organisationDirectory, platform, registryPath, tenantDatabasePath } from "./tenants.mjs";

const minute = 60_000;
const day = 24 * 60 * minute;
const retry = 5 * minute;
const leaseTime = 15 * minute;
const autoName = /^scheduled-[0-9]{13}\.wbbackup$/;
const fingerprint = key => createHash("sha256").update(key).digest("hex");
const contains = (parent, child) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

function setting(value, fallback, max) {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error("Invalid backup schedule.");
  return n;
}

export function backupSettings(env = process.env) {
  if (!env.WHISTLEBLOWER_KEYS_DIR || !env.WHISTLEBLOWER_ARCHIVE_DIR) return null;
  const keys = resolve(env.WHISTLEBLOWER_KEYS_DIR);
  const archive = resolve(env.WHISTLEBLOWER_ARCHIVE_DIR);
  return { keys, archive, interval: setting(env.WHISTLEBLOWER_BACKUP_INTERVAL_MINUTES, 60, 10080) * minute,
    retention: setting(env.WHISTLEBLOWER_BACKUP_RETENTION_DAYS, 7, 3650) * day };
}

async function checkDirectories(config) {
  await Promise.all([config.keys, config.archive].map(dir => mkdir(dir, { recursive: true, mode: 0o700 })));
  const [keys, archive] = await Promise.all([config.keys, config.archive].map(dir => realpath(dir)));
  if (contains(keys, archive) || contains(archive, keys)) throw new Error("Keep backup keys outside the archive.");
}

export function backupHealth(db, env = process.env) {
  let config;
  try { config = backupSettings(env); }
  catch { return { state: "configuration", problems: [], scopes: 0, protected: 0 }; }
  if (!config) return { state: "unconfigured", problems: [], scopes: 0, protected: 0 };
  const rows = db.prepare(`SELECT s.*, o.slug FROM scheduled_backups s LEFT JOIN organisations o ON s.scope=o.id`).all();
  const scopes = 1 + db.prepare("SELECT COUNT(*) n FROM organisations").get().n;
  const problems = [];
  for (const row of rows) {
    const overdue = Date.now() > (row.last_at ? row.last_at + config.interval : row.run_at ?? Date.now()) + leaseTime;
    if (row.error || overdue) problems.push({ scope: row.slug ?? "Platform registry", reason: row.error ?? "overdue" });
  }
  const protectedCount = rows.filter(row => row.last_at !== null).length;
  return { state: problems.length ? "attention" : protectedCount < scopes ? "starting" : "healthy",
    scopes, protected: protectedCount, problems, registryAt: rows.find(r => r.scope === platform)?.last_at ?? null };
}

async function keyFor(db, job, keyPath, directory) {
  let key;
  try {
    key = await readBackupKey(keyPath);
  } catch (error) {
    if (error.code !== "ENOENT" || job.key_hash) throw error;
    const files = await readdir(directory);
    if (files.some(name => name.endsWith(".wbbackup"))) throw new Error("Recover the existing backup key.");
    // Concurrent attempts publish keys exclusively. Always reread the winning file.
    try { await createBackupKey(keyPath); }
    catch (creationError) {
      try { key = await readBackupKey(keyPath); } catch { throw creationError; }
    }
    key ??= await readBackupKey(keyPath);
  }
  const digest = fingerprint(key);
  const linked = db.prepare(`UPDATE scheduled_backups SET key_hash=? WHERE scope=? AND lease=?
    AND (key_hash IS NULL OR key_hash=?)`).run(digest, job.scope, job.lease, digest);
  if (!linked.changes) { key.fill(0); throw new Error("Backup key changed or lease expired."); }
  return key;
}

function claim(db, scope, now) {
  return db.prepare(`UPDATE scheduled_backups SET lease=?, lease_until=?,
    checkpoint=CASE WHEN run_at IS NULL THEN (SELECT manifest FROM anchor_jobs WHERE org=? ORDER BY entries DESC LIMIT 1) ELSE checkpoint END,
    run_at=coalesce(run_at,?) WHERE scope=? AND lease_until<=? AND next_at<=? RETURNING *`)
    .get(randomUUID(), now + leaseTime, scope, now, scope, now, now);
}

function finish(db, job, directory, name, config, at) {
  transaction(db, () => {
    if (!db.prepare("SELECT 1 FROM scheduled_backups WHERE scope=? AND lease=?").get(job.scope, job.lease)) return;
    db.prepare("INSERT OR IGNORE INTO backup_archives(scope,name,created_at) VALUES(?,?,?)").run(job.scope, name, job.run_at);
    const expired = db.prepare("SELECT name FROM backup_archives WHERE scope=? AND created_at<? AND name!=?").all(job.scope, at - config.retention, name);
    for (const old of expired) {
      if (!autoName.test(old.name)) throw new Error("Unrecognised scheduled backup name.");
      try { unlinkSync(join(directory, old.name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      db.prepare("DELETE FROM backup_archives WHERE scope=? AND name=?").run(job.scope, old.name);
    }
    db.prepare(`UPDATE scheduled_backups SET last_at=?,next_at=?,run_at=NULL,checkpoint=NULL,lease=NULL,lease_until=0,error=NULL
      WHERE scope=? AND lease=?`).run(at, at + config.interval, job.scope, job.lease);
  });
}

export async function runBackupSweep(db, root, { config = backupSettings(), now = Date.now } = {}) {
  if (!config) return;
  db.prepare("INSERT OR IGNORE INTO scheduled_backups(scope) VALUES(?)").run(platform);
  db.exec("INSERT OR IGNORE INTO scheduled_backups(scope) SELECT id FROM organisations");
  const start = now();
  const due = db.prepare(`SELECT s.scope, o.id, o.log_id FROM scheduled_backups s
    LEFT JOIN organisations o ON o.id=s.scope WHERE s.next_at<=? AND s.lease_until<=?
    ORDER BY s.scope='platform',s.next_at,s.scope`).all(start, start);
  if (!due.length) return;
  // Protect case snapshots first, so the registry snapshot also records their recovery metadata.
  for (const org of due) {
    const job = claim(db, org.scope, now());
    if (!job) continue;
    const heartbeat = setInterval(() => {
      try {
        db.prepare("UPDATE scheduled_backups SET lease_until=? WHERE scope=? AND lease=?")
          .run(now() + leaseTime, job.scope, job.lease);
      } catch (error) {
        console.error("Backup lease renewal failed", job.scope, error.code || error.name);
      }
    }, minute);
    heartbeat.unref();
    let key, temporary;
    let stage = "storage";
    try {
      await checkDirectories(config);
      const isRegistry = org.scope === platform;
      const namespace = isRegistry ? join(config.archive, "platform") : organisationDirectory(config.archive, org);
      const directory = join(namespace, "backups");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      stage = "key";
      key = await keyFor(db, job, join(config.keys, isRegistry ? "platform-registry.wbkey" : org.id + ".wbkey"), directory);
      const checkpoint = job.checkpoint ? JSON.parse(job.checkpoint) : undefined;
      const name = `scheduled-${job.run_at}.wbbackup`;
      const file = join(directory, name);
      stage = "snapshot";
      // A published archive may already exist after an interrupted run. Authenticate it before adoption.
      if (!(await readdir(directory)).includes(name)) {
        if (isRegistry) await createEncryptedRegistryBackup(registryPath(root), file, key);
        else await createEncryptedBackup(tenantDatabasePath(root, org), file, key, checkpoint, org.log_id);
      }
      stage = "recovery";
      temporary = await mkdtemp(join(root, ".backup-check-"));
      const restored = join(temporary, "check.sqlite");
      if (isRegistry) await restoreEncryptedRegistryBackup(file, restored, key);
      else await restoreEncryptedBackup(file, restored, key, checkpoint, org.log_id);
      stage = "retention";
      finish(db, job, directory, name, config, now());
    } catch (error) {
      const changed = db.prepare(`UPDATE scheduled_backups SET error=?,next_at=?,lease=NULL,lease_until=0
        WHERE scope=? AND lease=?`).run(stage, now() + retry, job.scope, job.lease);
      if (changed.changes && job.error !== stage) console.error("Scheduled backup failed", job.scope, stage, error.code || error.name);
    } finally {
      clearInterval(heartbeat);
      key?.fill(0);
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
}
