import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createBackupKey, createEncryptedBackup, readBackupKey, restoreEncryptedBackup } from "../lib/backup.mjs";
import { verifyCaseHistory } from "../lib/case-history.mjs";
import { readCheckpoint, saveCheckpoint, stampCheckpoint, upgradeCheckpoint, verifyBitcoinAnchor } from "../lib/checkpoints.mjs";

import { findOrganisation, openRegistry, registryPath, tenantDatabasePath, tenantDirectory } from "../lib/tenants.mjs";

process.umask(0o077);

const usage = `Usage: npm run integrity -- <command> [options]

  keygen FILE                         Create a new private backup key
  backup FILE [--checkpoint FILE]     Write a new encrypted SQLite snapshot
  restore BACKUP DEST [--checkpoint FILE]
                                      Verify and restore to a new SQLite file
  verify [--checkpoint FILE]          Verify case history and optional checkpoint
  checkpoint FILE                     Write a new case history checkpoint
  stamp FILE                          Submit a checkpoint commitment to OpenTimestamps
  upgrade FILE                        Upgrade the checkpoint's .ots proof
  verify-anchor FILE                  Verify history, proof and Bitcoin attestation

Options: --db FILE selects the SQLite database for backup, verify, checkpoint,
stamp and verify-anchor. The default is whistleblower.sqlite in
WHISTLEBLOWER_DATA_DIR or the repository's .data directory.

SaaS mode requires --org SLUG and uses the organisation's own database,
key and archive directories. Use filenames for backup and checkpoint
artifacts, and a recovery label for the restore destination. With --org,
keygen takes no filename.
`;

function verify(path, checkpoint, logId) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return verifyCaseHistory(db, checkpoint, logId); } finally { db.close(); }
}

function requireDirectory(name) {
  if (!process.env[name]) throw new Error(`Set ${name} to a protected directory before running this command.`);
  return resolve(process.env[name]);
}

function artifactName(name, suffix = "") {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,126}$/.test(name ?? "") || !name.endsWith(suffix)) {
    throw new Error(`Use a simple organisation artifact name${suffix ? ` ending in ${suffix}` : ""}.`);
  }
  return name;
}

function operatorPaths(root, org, values, command, operands) {
  if (!org) {
    return {
      files: operands.map((operand) => resolve(operand)),
      dbPath: resolve(values.db || join(root, "whistleblower.sqlite")),
      checkpointFile: values.checkpoint ? resolve(values.checkpoint) : null,
      keyPath: process.env.WHISTLEBLOWER_BACKUP_KEY_FILE,
    };
  }
  const registry = openRegistry(root, { readOnly: true });
  let row;
  try { row = findOrganisation(registry, org); } finally { registry.close(); }
  if (!row) throw new Error("Unknown organisation.");
  const keyPath = ["keygen", "backup", "restore"].includes(command)
    ? join(requireDirectory("WHISTLEBLOWER_KEYS_DIR"), row.id + ".wbkey") : null;
  const archive = command !== "keygen" && (operands.length || values.checkpoint)
    ? join(requireDirectory("WHISTLEBLOWER_ARCHIVE_DIR"), row.id) : null;
  const checkpointFile = values.checkpoint ? join(archive, "checkpoints", artifactName(values.checkpoint, ".json")) : null;
  let files = [];
  if (command === "keygen") files = [keyPath];
  else if (command === "backup" || command === "restore") {
    files = [join(archive, "backups", artifactName(operands[0], ".wbbackup"))];
    if (command === "restore") {
      files.push(join(tenantDirectory(root, row), "recovery", artifactName(operands[1]), "whistleblower.sqlite"));
    }
  } else if (operands.length) files = [join(archive, "checkpoints", artifactName(operands[0], ".json"))];
  return { files, keyPath, checkpointFile, dbPath: tenantDatabasePath(root, row), logId: row.log_id };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { db: { type: "string" }, checkpoint: { type: "string" }, org: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help || positionals.length === 0) {
    console.log(usage);
    return;
  }
  const [command, ...operands] = positionals;
  const expected = { keygen: values.org ? 0 : 1, backup: 1, restore: 2, verify: 0, checkpoint: 1, stamp: 1, upgrade: 1, "verify-anchor": 1 };
  if (!Object.hasOwn(expected, command) || operands.length !== expected[command]
    || (values.checkpoint && !["verify", "backup", "restore"].includes(command))
    || (values.db && (values.org || ["keygen", "upgrade", "restore"].includes(command)))) {
    throw new Error(usage);
  }
  const root = resolve(process.env.WHISTLEBLOWER_DATA_DIR || fileURLToPath(new URL("../.data", import.meta.url)));
  if (!values.org && (process.env.WHISTLEBLOWER_MODE === "saas" || existsSync(registryPath(root)))) {
    throw new Error("SaaS integrity commands require --org SLUG.");
  }
  const { files: [file, destination], dbPath, checkpointFile, keyPath, logId } = operatorPaths(root, values.org, values, command, operands);
  const expectedCheckpoint = checkpointFile ? (await readCheckpoint(checkpointFile)).checkpoint : undefined;
  if (expectedCheckpoint && logId && expectedCheckpoint.logId !== logId) {
    throw new Error("Checkpoint belongs to a different organisation.");
  }

  if (command === "keygen") {
    await createBackupKey(file);
    return console.log("Backup key created. Keep a recovery copy separate from the backups.");
  }
  if (command === "backup" || command === "restore") {
    const key = await readBackupKey(keyPath);
    try {
      if (command === "backup") await createEncryptedBackup(dbPath, file, key, expectedCheckpoint, logId);
      else await restoreEncryptedBackup(file, destination, key, expectedCheckpoint, logId);
    } finally { key.fill(0); }
    return console.log(command === "backup" ? "Encrypted backup created." : "Backup authenticated and restored to the new SQLite file.");
  }
  if (command === "verify") {
    const { entries } = verify(dbPath, expectedCheckpoint, logId);
    return console.log(`Case history verified (${entries} entries${expectedCheckpoint ? ", including the retained checkpoint" : ""}).`);
  }
  if (command === "checkpoint") {
    const checkpoint = verify(dbPath, undefined, logId);
    if (!checkpoint.entries) throw new Error("An empty case history cannot be checkpointed.");
    await saveCheckpoint(file, checkpoint);
    return console.log(`Checkpoint saved for ${checkpoint.entries} case history entries.`);
  }

  const { checkpoint, contents, digest } = await readCheckpoint(file);
  if (logId && checkpoint.logId !== logId) throw new Error("Checkpoint belongs to a different organisation.");
  if (command !== "upgrade") verify(dbPath, checkpoint, logId);
  if (command === "stamp") {
    await stampCheckpoint(file, digest, contents);
    return console.log("OpenTimestamps proof saved. Bitcoin confirmation is pending until verified.");
  }
  if (command === "upgrade") {
    await upgradeCheckpoint(file, digest);
    return console.log("Proof checked for upgrades. Use verify-anchor to check Bitcoin confirmation.");
  }
  const block = await verifyBitcoinAnchor(file, digest);
  console.log(`Case history checkpoint verified against Bitcoin block ${block}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
