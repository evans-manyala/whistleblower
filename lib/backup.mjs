import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, appendFile, link, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { verifyCaseHistory } from "./case-history.mjs";

const magic = Buffer.from("WBBACKUP\x01");
const headerSize = magic.length + 12;
const tagSize = 16;

async function requireUnused(destination) {
  try {
    await access(destination, constants.F_OK);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Destination already exists: ${destination}`);
}

export async function writeNewFile(destination, write) {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await requireUnused(destination);
  const temporary = await mkdtemp(join(parent, ".whistleblower-write-"));
  try {
    const path = join(temporary, "contents");
    await write(path);
    const file = await open(path, "r");
    try { await file.sync(); } finally { await file.close(); }
    await link(path, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function createBackupKey(destination) {
  await writeNewFile(destination, (path) => writeFile(path, randomBytes(32), { mode: 0o600, flag: "wx" }));
}

export async function readBackupKey(path) {
  if (!path) throw new Error("Set WHISTLEBLOWER_BACKUP_KEY_FILE to a private 32-byte key file.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size !== 32) {
      throw new Error("The backup key must be a regular 32-byte file accessible only to its owner.");
    }
    const key = await file.readFile();
    if (key.length !== 32) throw new Error("The backup key changed while it was being read.");
    return key;
  } finally {
    await file.close();
  }
}

function verifyDatabase(db, checkpoint) {
  const result = db.prepare("PRAGMA quick_check").all();
  if (result.length !== 1 || result[0].quick_check !== "ok") throw new Error("SQLite consistency check failed.");
  return verifyCaseHistory(db, checkpoint);
}

export async function createEncryptedBackup(source, destination, key, checkpoint) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await writeNewFile(destination, async (encrypted) => {
      // Keep the unencrypted SQLite snapshot on the source side, away from backup storage.
      const temporary = await mkdtemp(join(dirname(source), ".whistleblower-snapshot-"));
      try {
        const snapshot = join(temporary, "snapshot.sqlite");
        await backup(db, snapshot);
        const snapshotDb = new DatabaseSync(snapshot);
        try {
          snapshotDb.exec("PRAGMA journal_mode = DELETE; PRAGMA secure_delete = ON;");
          verifyDatabase(snapshotDb, checkpoint);
          snapshotDb.exec("DELETE FROM sessions;");
        } finally {
          snapshotDb.close();
        }

        const iv = randomBytes(12);
        const header = Buffer.concat([magic, iv]);
        const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: tagSize });
        cipher.setAAD(header);
        await writeFile(encrypted, header, { mode: 0o600, flag: "wx" });
        await pipeline(createReadStream(snapshot), cipher, createWriteStream(encrypted, { flags: "a" }));
        await appendFile(encrypted, cipher.getAuthTag());
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  } finally {
    db.close();
  }
}

export async function restoreEncryptedBackup(source, destination, key, checkpoint) {
  for (const suffix of ["-wal", "-shm", "-journal"]) await requireUnused(destination + suffix);
  const file = await open(source, "r");
  try {
    const size = (await file.stat()).size;
    if (size <= headerSize + tagSize) throw new Error("Backup is empty or truncated.");
    const header = Buffer.alloc(headerSize);
    const tag = Buffer.alloc(tagSize);
    const [first, last] = await Promise.all([
      file.read(header, 0, header.length, 0),
      file.read(tag, 0, tag.length, size - tag.length),
    ]);
    if (first.bytesRead !== header.length || last.bytesRead !== tag.length || !header.subarray(0, magic.length).equals(magic)) {
      throw new Error("Invalid encrypted backup format.");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(magic.length), { authTagLength: tagSize });
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    await writeNewFile(destination, async (database) => {
      try {
        await pipeline(file.createReadStream({ start: headerSize, end: size - tagSize - 1, autoClose: false }),
          decipher, createWriteStream(database, { flags: "wx", mode: 0o600 }));
      } catch (error) {
        if (/authenticate data/i.test(error.message)) throw new Error("Backup authentication failed. Check the key and backup contents.");
        throw error;
      }
      const db = new DatabaseSync(database, { readOnly: true });
      try { verifyDatabase(db, checkpoint); } finally { db.close(); }
    });
  } finally {
    await file.close();
  }
}
