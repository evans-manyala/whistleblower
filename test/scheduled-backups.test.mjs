import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { readBackupKey, restoreEncryptedBackup, restoreEncryptedRegistryBackup } from "../lib/backup.mjs";
import { backupHealth, backupSettings, runBackupSweep } from "../lib/scheduled-backups.mjs";
import { createPlatformStore, findOrganisation, openRegistry } from "../lib/tenants.mjs";

test("scheduled backups survive retries, isolate tenant keys, scrub registry access, and retain recent restore-checked archives", async t => {
  const temp = await mkdtemp(join(tmpdir(),"wb-scheduler-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp,"data"), keys = join(temp,"keys"), archive = join(temp,"archives");
  const env = { WHISTLEBLOWER_KEYS_DIR: keys, WHISTLEBLOWER_ARCHIVE_DIR: archive, WHISTLEBLOWER_BACKUP_RETENTION_DAYS: "1" };
  const config = backupSettings(env), registry = openRegistry(root), competitor = openRegistry(root);
  t.after(() => { competitor.close(); registry.close(); });
  const store = createPlatformStore(registry, root);
  const first = store.provision({slug:"alpha",name:"Alpha",adminEmail:"alpha@example.test"});
  await store.accept(findOrganisation(registry,"alpha").id, {code:first.invite.code, password:"Test account passphrase"});
  store.provision({slug:"beta",name:"Beta",adminEmail:"beta@example.test"});
  const alpha = findOrganisation(registry,"alpha"), beta = findOrganisation(registry,"beta");
  store.setOrganisationActive("beta", false);
  const folder = scope => join(archive,scope,"backups");
  let clock = Date.now();
  const sweep = (db = registry) => runBackupSweep(db, root, { config, now: () => clock });
  const rows = () => registry.prepare("SELECT * FROM backup_archives ORDER BY scope,created_at").all();
  assert.equal(backupHealth(registry,{}).state, "unconfigured");
  assert.equal(backupHealth(registry,env).state, "starting");
  await Promise.all([sweep(),sweep(competitor)]);
  assert.equal(rows().length,3);
  assert.equal(backupHealth(registry,env).state, "healthy");
  const earliest = rows(), name = earliest[0].name;
  const platformKey = await readBackupKey(join(keys,"platform-registry.wbkey"));
  const alphaKey = await readBackupKey(join(keys,alpha.id+".wbkey"));
  const betaKey = await readBackupKey(join(keys,beta.id+".wbkey"));
  assert.notDeepEqual(alphaKey,betaKey);
  assert.notDeepEqual(platformKey,alphaKey);
  const restored = join(temp,"registry.sqlite");
  await restoreEncryptedRegistryBackup(join(folder("platform"),name),restored,platformKey);
  const snapshot = new DatabaseSync(restored,{readOnly:true});
  try {
    for (const table of ["invites","auth_sessions"]) assert.equal(snapshot.prepare("SELECT count(*) n FROM "+table).get().n,0);
    assert.equal(snapshot.prepare("SELECT count(*) n FROM accounts").get().n,1);
    assert.equal(snapshot.prepare("SELECT count(*) n FROM organisations").get().n,2);
    assert.equal(registry.prepare("SELECT count(*) n FROM auth_sessions").get().n,1);
  } finally { snapshot.close(); }
  await assert.rejects(restoreEncryptedBackup(join(folder("platform"),name),join(temp,"cross-reg.sqlite"),platformKey,undefined,alpha.log_id),/authentication failed/);
  await assert.rejects(restoreEncryptedBackup(join(folder(beta.id),name),join(temp,"cross-org.sqlite"),alphaKey,undefined,beta.log_id),/authentication failed/);
  // Crash between publishing and recording the snapshot. Reuse and authenticate the existing file.
  const initial = await readFile(join(folder(alpha.id),name));
  registry.prepare("UPDATE scheduled_backups SET run_at=?,next_at=0 WHERE scope=?").run(clock,alpha.id);
  await sweep();
  assert.deepEqual(await readFile(join(folder(alpha.id),name)),initial);
  assert.equal(rows().length,3);
  const originalKey = join(keys,alpha.id+".wbkey");
  await rename(originalKey, originalKey+".saved");
  clock += 2*86400_000;
  await writeFile(join(folder(alpha.id),"manual.wbbackup"),"operator archive");
  await sweep();
  assert.equal(backupHealth(registry,env).problems.find(r=>r.scope==="alpha").reason,"key");
  await assert.rejects(stat(originalKey),{code:"ENOENT"});
  assert.deepEqual(await readFile(join(folder(alpha.id),name)),initial);
  assert.equal((await readdir(folder(beta.id))).includes(name),false);
  // An unusable published archive cannot pass recovery or expire the last good snapshot.
  const retryName = "scheduled-"+clock+".wbbackup";
  const damaged = join(folder(alpha.id),retryName);
  await writeFile(damaged,"truncated");
  await rename(originalKey+".saved",originalKey);
  clock += 5*60_000;
  await sweep();
  assert.equal(backupHealth(registry,env).problems.find(r=>r.scope==="alpha").reason,"recovery");
  assert.deepEqual(await readFile(join(folder(alpha.id),name)),initial);
  await rename(damaged,damaged+".quarantined");
  clock += 5*60_000;
  await sweep();
  assert.equal(backupHealth(registry,env).state,"healthy");
  assert.equal(await readFile(join(folder(alpha.id),"manual.wbbackup"),"utf8"),"operator archive");
  assert.equal((await readdir(folder(alpha.id))).includes(name),false);
  assert.equal(rows().length,3);
  platformKey.fill(0); alphaKey.fill(0); betaKey.fill(0);
});

test("nested archive and key directories are reported as an operator failure", async t => {
  const temp = await mkdtemp(join(tmpdir(),"wb-nested-"));
  t.after(() => rm(temp,{recursive:true,force:true}));
  const root=join(temp,"data"), archive=join(temp,"archive");
  await mkdir(archive);
  const env={ WHISTLEBLOWER_KEYS_DIR:join(archive,"keys"), WHISTLEBLOWER_ARCHIVE_DIR:archive };
  const db=openRegistry(root);
  try {
    await runBackupSweep(db,root,{config:backupSettings(env)});
    assert.equal(backupHealth(db,env).problems[0].reason,"storage");
    assert.deepEqual(await readdir(env.WHISTLEBLOWER_KEYS_DIR),[]);
  } finally { db.close(); }
});
