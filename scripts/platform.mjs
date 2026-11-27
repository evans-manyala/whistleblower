import { readBackupKey, restoreEncryptedRegistryBackup } from "../lib/backup.mjs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlatformStore, openRegistry } from "../lib/tenants.mjs";

process.umask(0o077);

const [command, operand, ...extra] = process.argv.slice(2);
if (command === "restore-registry" && /^scheduled-[0-9]{13}\.wbbackup$/.test(operand) && extra.length === 1) {
  let key;
  try {
    const keys = process.env.WHISTLEBLOWER_KEYS_DIR;
    const archive = process.env.WHISTLEBLOWER_ARCHIVE_DIR;
    if (!keys || !archive) throw new Error("Set WHISTLEBLOWER_KEYS_DIR and WHISTLEBLOWER_ARCHIVE_DIR.");
    key = await readBackupKey(join(keys, "platform-registry.wbkey"));
    await restoreEncryptedRegistryBackup(join(archive, "platform", "backups", operand), resolve(extra[0]), key);
    console.log("Platform registry authenticated and restored to the new file.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { key?.fill(0); }
} else if (command !== "create-admin" || !operand || extra.length) {
  console.error("Usage: npm run platform -- create-admin EMAIL | restore-registry ARCHIVE_NAME NEW_DATABASE");
  process.exitCode = 1;
} else {
  const root = resolve(process.env.WHISTLEBLOWER_DATA_DIR || fileURLToPath(new URL("../.data", import.meta.url)));
  const password = process.env.WHISTLEBLOWER_PLATFORM_ADMIN_PASSWORD;
  if (!password) {
    console.error("Set WHISTLEBLOWER_PLATFORM_ADMIN_PASSWORD in the process environment.");
    process.exitCode = 1;
  } else {
    const registry = openRegistry(root);
    try {
      await createPlatformStore(registry, root).createPlatformAdmin(operand, password);
      console.log("Platform administrator created.");
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    } finally { registry.close(); }
  }
}
