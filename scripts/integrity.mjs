import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createBackupKey, createEncryptedBackup, readBackupKey, restoreEncryptedBackup } from "../lib/backup.mjs";
import { verifyCaseHistory } from "../lib/case-history.mjs";
import { readCheckpoint, saveCheckpoint, stampCheckpoint, upgradeCheckpoint, verifyBitcoinAnchor } from "../lib/checkpoints.mjs";

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
`;

function verify(path, checkpoint) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return verifyCaseHistory(db, checkpoint); } finally { db.close(); }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { db: { type: "string" }, checkpoint: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help || positionals.length === 0) {
    console.log(usage);
    return;
  }
  const [command, ...operands] = positionals;
  const expected = { keygen: 1, backup: 1, restore: 2, verify: 0, checkpoint: 1, stamp: 1, upgrade: 1, "verify-anchor": 1 };
  if (!Object.hasOwn(expected, command) || operands.length !== expected[command]
    || (values.checkpoint && !["verify", "backup", "restore"].includes(command))
    || (values.db && ["keygen", "upgrade", "restore"].includes(command))) {
    throw new Error(usage);
  }
  const [file, destination] = operands.map((operand) => resolve(operand));
  const dbPath = resolve(values.db || join(process.env.WHISTLEBLOWER_DATA_DIR || fileURLToPath(new URL("../.data", import.meta.url)), "whistleblower.sqlite"));
  const expectedCheckpoint = values.checkpoint ? (await readCheckpoint(resolve(values.checkpoint))).checkpoint : undefined;

  if (command === "keygen") {
    await createBackupKey(file);
    return console.log("Backup key created. Keep a recovery copy separate from the backups.");
  }
  if (command === "backup" || command === "restore") {
    const key = await readBackupKey(process.env.WHISTLEBLOWER_BACKUP_KEY_FILE);
    try {
      if (command === "backup") await createEncryptedBackup(dbPath, file, key, expectedCheckpoint);
      else await restoreEncryptedBackup(file, destination, key, expectedCheckpoint);
    } finally { key.fill(0); }
    return console.log(command === "backup" ? "Encrypted backup created." : "Backup authenticated and restored to the new SQLite file.");
  }
  if (command === "verify") {
    const { entries } = verify(dbPath, expectedCheckpoint);
    return console.log(`Case history verified (${entries} entries${expectedCheckpoint ? ", including the retained checkpoint" : ""}).`);
  }
  if (command === "checkpoint") {
    const checkpoint = verify(dbPath);
    if (!checkpoint.entries) throw new Error("An empty case history cannot be checkpointed.");
    await saveCheckpoint(file, checkpoint);
    return console.log(`Checkpoint saved for ${checkpoint.entries} case history entries.`);
  }

  const { checkpoint, contents, digest } = await readCheckpoint(file);
  if (command !== "upgrade") verify(dbPath, checkpoint);
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
