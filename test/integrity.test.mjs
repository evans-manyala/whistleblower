import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { caseHistoryWriter, initializeDatabase, migrateEvidence, transaction, verifyCaseHistory } from "../lib/case-history.mjs";

const run = promisify(execFile);
const at = "2026-02-15T10:30:00.000Z";
const fakeDescription = "Fictional evidence for a backup and tampering test.";
const reference = "WB-ABCD112233445566";
const restoredStatus = "reviewing";

async function workspace(context) {
  const path = await mkdtemp(join(tmpdir(), "whistleblower-integrity-test-"));
  context.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function database(path, run, options = {}) {
  const db = new DatabaseSync(path, options);
  try { return run(db); } finally { db.close(); }
}

function seed(path) {
  database(path, (db) => {
    initializeDatabase(db);
    const history = caseHistoryWriter(db);
    transaction(db, () => {
      db.prepare("INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)").run(
        reference, "fictional code hash", "fictional submission hash", "other",
        "Fictional concern", fakeDescription, restoredStatus, at, at,
      );
      history.recordSubmission(reference);
      const insert = db.prepare("INSERT INTO events (report_id, kind, actor, value, created_at) VALUES (?, ?, ?, ?, ?)");
      history.recordEvent(reference, insert.run(reference, "status", "system", "received", at).lastInsertRowid);
      history.recordEvent(reference, insert.run(reference, "message", "reporter", "Fictional follow-up.", at).lastInsertRowid);
      history.recordEvent(reference, insert.run(reference, "status", "reviewer", restoredStatus, at).lastInsertRowid);
    });
    db.prepare("INSERT INTO sessions VALUES (?, ?)").run("fixture session", Date.now() + 300_000);
  });
}

function integrity(key, ...arguments_) {
  return run(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/integrity.mjs", ...arguments_], {
    env: { ...process.env, WHISTLEBLOWER_BACKUP_KEY_FILE: key },
  });
}

function expectFailure(promise, pattern) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, pattern);
    return true;
  });
}

test("encrypted snapshot restores a deleted report and rejects invalid or tampered data", async (context) => {
  const temporary = await workspace(context);
  const live = join(temporary, "live.sqlite");
  const restored = join(temporary, "restored", "whistleblower.sqlite");
  const backup = join(temporary, "snapshot.wbbackup");
  const key = join(temporary, "key");
  const alternateKey = join(temporary, "wrong-key");
  const checkpoint = join(temporary, "checkpoint.json");
  seed(live);
  await integrity(key, "keygen", key);
  await integrity(key, "keygen", alternateKey);
  assert.equal((await stat(key)).mode & 0o777, 0o600);
  await integrity(key, "checkpoint", checkpoint, "--db", live);
  const retained = JSON.parse(await readFile(checkpoint, "utf8"));
  assert.equal(retained.entries, 4);
  await integrity(key, "backup", backup, "--db", live, "--checkpoint", checkpoint);
  await expectFailure(integrity(key, "backup", backup, "--db", live), /already exists/);
  const archive = await readFile(backup);
  assert.equal(archive.includes(Buffer.from(fakeDescription)), false);
  assert.equal(archive.includes(Buffer.from("SQLite format 3")), false);

  database(live, (db) => {
    assert.throws(() => db.exec("DELETE FROM reports"), /FOREIGN KEY/);
    assert.throws(() => db.exec("UPDATE events SET value = 'edited'"), /append-only/);
    assert.throws(() => db.exec("DELETE FROM case_history"), /append-only/);
  });

  database(live, (db) => {
    assert.equal(db.prepare("DELETE FROM reports WHERE id = ?").run(reference).changes, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reports").get().count, 0);
  }, { enableForeignKeyConstraints: false });
  await expectFailure(integrity(key, "verify", "--db", live, "--checkpoint", checkpoint), /Submission is missing/);
  await integrity(key, "restore", backup, restored, "--checkpoint", checkpoint);
  database(restored, (db) => {
    const report = db.prepare("SELECT description, status FROM reports WHERE id = ?").get(reference);
    assert.equal(report.description, fakeDescription);
    assert.equal(report.status, restoredStatus);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events").get().count, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
  });
  await expectFailure(integrity(key, "restore", backup, restored), /already exists/);

  const rejected = join(temporary, "rejected.sqlite");
  await expectFailure(integrity(alternateKey, "restore", backup, rejected), /authentication failed/);
  await assert.rejects(stat(rejected), { code: "ENOENT" });
  const damagedBackup = join(temporary, "damaged.wbbackup");
  archive[archive.length - 25] ^= 0xff;
  await writeFile(damagedBackup, archive);
  await expectFailure(integrity(key, "restore", damagedBackup, rejected), /authentication failed/);
  await assert.rejects(stat(rejected), { code: "ENOENT" });
  await integrity(key, "verify", "--db", restored, "--checkpoint", checkpoint);

  database(restored, (db) => {
    db.prepare("UPDATE reports SET description = ? WHERE id = ?").run("Edited contents", reference);
  });
  await expectFailure(integrity(key, "verify", "--db", restored), /contents do not match/);
  await expectFailure(integrity(key, "backup", join(temporary, "rejected.wbbackup"), "--db", restored), /contents do not match/);

  database(restored, (db) => {
    transaction(db, () => {
      db.exec("DROP TRIGGER case_history_no_delete; DELETE FROM case_history");
      const history = caseHistoryWriter(db);
      history.recordSubmission(reference);
      for (const row of db.prepare("SELECT id FROM events ORDER BY id").iterate()) history.recordEvent(reference, row.id);
      db.exec("CREATE TRIGGER case_history_no_delete BEFORE DELETE ON case_history BEGIN SELECT RAISE(ABORT, 'Case history is append-only'); END;");
    });
  });
  await integrity(key, "verify", "--db", restored);
  await expectFailure(integrity(key, "verify", "--db", restored, "--checkpoint", checkpoint), /root does not match/);
});

test("pre-existing case history migrates once and retained checkpoints verify the committed prefix", async (context) => {
  const temporary = await workspace(context);
  const path = join(temporary, "legacy.sqlite");
  const checkpoint = join(temporary, "checkpoint.json");
  seed(path);
  database(path, (db) => db.exec(`
    DROP TABLE case_history;
    DROP TABLE integrity_log;
    DROP TRIGGER case_events_no_update;
    DROP TRIGGER case_events_no_delete;
    PRAGMA user_version = 0;
  `));
  database(path, (db) => initializeDatabase(db));
  await integrity("", "checkpoint", checkpoint, "--db", path);
  database(path, (db) => {
    initializeDatabase(db);
    transaction(db, () => {
      const message = db.prepare("INSERT INTO events (report_id, kind, actor, value, created_at) VALUES (?, 'message', 'reviewer', ?, ?)");
      caseHistoryWriter(db).recordEvent(reference, message.run(reference, "New fictional message.", at).lastInsertRowid);
    });
  });
  const result = await integrity("", "verify", "--db", path, "--checkpoint", checkpoint);
  assert.match(result.stdout, /5 entries, including the retained checkpoint/);
});

test("adding evidence storage preserves retained v1 checkpoints and open reviewer sessions", async context => {
  const path = join(await workspace(context), "v1.sqlite");
  seed(path);
  database(path, db => {
    db.exec("DROP TABLE evidence; DROP TABLE evidence_key; PRAGMA user_version=1;");
    const checkpoint = verifyCaseHistory(db);
    migrateEvidence(db);
    migrateEvidence(db);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
    assert.deepEqual(verifyCaseHistory(db, checkpoint), checkpoint);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 1);
  });
});

test("OpenTimestamps commands bind the proof to the verified checkpoint digest", async (context) => {
  const temporary = await workspace(context);
  const path = join(temporary, "live.sqlite");
  const checkpoint = join(temporary, "checkpoint.json");
  const client = join(temporary, "fake-ots.mjs");
  seed(path);
  await integrity("", "checkpoint", checkpoint, "--db", path);
  await writeFile(client, `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const [cache, command, ...args] = process.argv.slice(2);
if (cache !== "--no-cache") process.exit(1);
const file = args.at(-1);
if (command === "stamp") {
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  writeFileSync(file + ".ots", JSON.stringify({ digest, confirmed: false }));
} else {
  const proof = JSON.parse(readFileSync(file, "utf8"));
  if (command === "info") console.log("File sha256 hash: " + proof.digest);
  if (command === "upgrade") writeFileSync(file, JSON.stringify({ ...proof, confirmed: true }));
  if (command === "verify") {
    if (args[0] !== "-d" || args[1] !== proof.digest || !proof.confirmed) process.exit(1);
    console.error("Success! Bitcoin block 123456 attests existence");
  }
}
`, { mode: 0o700 });
  const anchor = (...arguments_) => run(process.execPath,
    ["--disable-warning=ExperimentalWarning", "scripts/integrity.mjs", ...arguments_],
    { env: { ...process.env, WHISTLEBLOWER_OTS_BIN: client } });
  await anchor("stamp", checkpoint, "--db", path);
  await expectFailure(anchor("verify-anchor", checkpoint, "--db", path), /OpenTimestamps verify failed/);
  await anchor("upgrade", checkpoint);
  assert.match((await anchor("verify-anchor", checkpoint, "--db", path)).stdout, /Bitcoin block 123456/);
  const expectedProof = JSON.parse(await readFile(checkpoint + ".ots", "utf8"));
  assert.equal(expectedProof.digest, createHash("sha256").update(await readFile(checkpoint)).digest("hex"));

  const edited = join(temporary, "edited.json");
  await copyFile(checkpoint + ".ots", edited + ".ots");
  await writeFile(edited, (await readFile(checkpoint, "utf8")) + "\n");
  await expectFailure(anchor("verify-anchor", edited, "--db", path), /proof does not belong/);

  database(path, (db) => db.exec("UPDATE reports SET status = 'resolved'"));
  await expectFailure(anchor("verify-anchor", checkpoint, "--db", path), /status or update time differs/);
});
