import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlatformStore, openRegistry } from "../lib/tenants.mjs";

process.umask(0o077);

const [command, email, ...extra] = process.argv.slice(2);
if (command !== "create-admin" || !email || extra.length) {
  console.error("Usage: npm run platform -- create-admin EMAIL");
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
      await createPlatformStore(registry, root).createPlatformAdmin(email, password);
      console.log("Platform administrator created.");
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    } finally { registry.close(); }
  }
}
