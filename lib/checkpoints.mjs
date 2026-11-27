import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { writeNewFile } from "./backup.mjs";
import { validateCheckpoint } from "./case-history.mjs";

const runFile = promisify(execFile);

export async function readCheckpoint(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 2048) throw new Error("Invalid case history checkpoint file.");
  const contents = await readFile(path);
  let checkpoint;
  try { checkpoint = JSON.parse(contents); } catch { throw new Error("Invalid case history checkpoint JSON."); }
  return { checkpoint: validateCheckpoint(checkpoint), contents, digest: createHash("sha256").update(contents).digest("hex") };
}

export function saveCheckpoint(path, checkpoint) {
  validateCheckpoint(checkpoint);
  return writeNewFile(path, (temporary) => writeFile(temporary, JSON.stringify(checkpoint) + "\n", { mode: 0o600, flag: "wx" }));
}

export class PendingBitcoinConfirmation extends Error {}

async function ots(args) {
  const executable = process.env.WHISTLEBLOWER_OTS_BIN || "ots";
  try {
    const result = await runFile(executable, ["--no-cache", ...args], { timeout: 30_000, maxBuffer: 256 * 1024 });
    return result.stdout + result.stderr;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Install the official OpenTimestamps client or set WHISTLEBLOWER_OTS_BIN.");
    if (error.killed) throw new Error("OpenTimestamps timed out. Retry the operation.");
    const detail = (error.stderr || error.stdout || "").trim();
    if (args[0] === "upgrade" && /Pending confirmation in Bitcoin blockchain/.test(detail)
        && /Failed! Timestamp not complete/.test(detail)) throw new PendingBitcoinConfirmation(`OpenTimestamps upgrade failed.\n${detail}`);
    throw new Error(`OpenTimestamps ${args[0]} failed.${detail ? "\n" + detail : ""}`);
  }
}

export async function checkProofDigest(file, digest) {
  const info = await ots(["info", file]);
  if (info.match(/^File sha256 hash: ([0-9a-f]{64})$/m)?.[1] !== digest) {
    throw new Error("The OpenTimestamps proof does not belong to this checkpoint.");
  }
}

export async function stampCheckpoint(file, digest, contents) {
  // The CLI hashes the checkpoint locally. Only an opaque commitment reaches the calendar.
  await writeNewFile(file + ".ots", async (destination) => {
    const staged = destination + ".json";
    await writeFile(staged, contents, { mode: 0o600, flag: "wx" });
    await ots(["stamp", staged]);
    await checkProofDigest(staged + ".ots", digest);
    await rename(staged + ".ots", destination);
  });
}

export async function upgradeCheckpoint(file, digest) {
  const proof = file + ".ots";
  const temporary = await mkdtemp(join(dirname(proof), ".whistleblower-upgrade-"));
  try {
    const staged = join(temporary, "checkpoint.ots");
    await copyFile(proof, staged);
    await checkProofDigest(staged, digest);
    await ots(["upgrade", staged]);
    await checkProofDigest(staged, digest);
    await rename(staged, proof);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyBitcoinAnchor(file, digest) {
  const proof = file + ".ots";
  await checkProofDigest(proof, digest);
  const output = await ots(["verify", "-d", digest, proof]);
  const block = output.match(/Success! Bitcoin block (\d+) attests existence/)?.[1];
  if (!block) throw new Error("OpenTimestamps returned no verified Bitcoin block.");
  return block;
}
