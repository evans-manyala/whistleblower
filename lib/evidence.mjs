import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import sharp from "sharp";
import { createBackupKey, readBackupKey } from "./backup.mjs";
import { HttpError } from "./http.mjs";

const MiB = 1024 * 1024;
export const evidenceBodyLimit = 12 * MiB;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const reject = message => new HttpError(400, message, "evidence");
const keyUnavailable = () => new HttpError(503, "The organisation’s evidence key is unavailable. Contact the service operator.");
const formats = { jpg: "jpeg", jpeg: "jpeg", png: "png", webp: "webp", txt: "text" };
let processing = 0;

export async function withEvidenceCapacity(run) {
  if (processing >= 3) throw new HttpError(429, "Evidence processing is busy. Try again shortly.");
  processing++;
  try { return await run(); } finally { processing--; }
}

function decodeFiles(items) {
  if (!Array.isArray(items) || !items.length || items.length > 3) throw reject("Choose one to three evidence files.");
  let total = 0;
  return items.map(item => {
    const name = item?.name;
    if (typeof name !== "string" || !name.isWellFormed() || !name.trim() || name.length > 180 ||
        /[\\/\p{Cc}\p{Cf}]/u.test(name)) throw reject("Use a filename of up to 180 characters without path separators or control characters.");
    const ext = name.toLowerCase().split(".").at(-1);
    if (!name.includes(".") || !Object.hasOwn(formats, ext)) throw reject("Choose a JPEG, PNG, WebP or UTF-8 .txt file.");
    const encoded = item.data;
    if (typeof encoded !== "string" || !encoded.length || encoded.length > 4 * Math.ceil(4 * MiB / 3)) {
      throw reject("Each evidence file must contain data and be at most 4 MiB.");
    }
    const bytes = Buffer.from(encoded, "base64");
    total += bytes.length;
    if (!bytes.length || bytes.length > 4 * MiB || total > 8 * MiB || bytes.toString("base64") !== encoded) {
      throw reject("Choose valid files up to 4 MiB each and 8 MiB in total.");
    }
    return { name, bytes, format: formats[ext] };
  });
}

function imageFormat(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
}

// PNG decoders may expose only the default frame of an APNG.
function animatedPng(bytes) {
  for (let offset = 8; offset + 12 <= bytes.length; offset += 12 + bytes.readUInt32BE(offset)) {
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
  }
  return false;
}

async function makePreview(file) {
  if (file.format === "text") {
    let value;
    try { value = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes); }
    catch { throw reject("Text evidence must be a UTF-8 plain-text file."); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(value)) throw reject("This file contains binary or non-text control characters.");
    let end = Math.min(32_768, value.length);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
    return { bytes: gzipSync(value.slice(0, end)), kind: "text", truncated: end < value.length };
  }
  if (imageFormat(file.bytes) !== file.format) throw reject("The image contents do not match its filename.");
  if (file.format === "png" && animatedPng(file.bytes)) throw reject("Choose a single-frame image.");
  try {
    const pipeline = sharp(file.bytes, { limitInputPixels: 32_000_000, failOn: "warning" });
    const meta = await pipeline.metadata();
    if (meta.format !== file.format || (meta.pages ?? 1) !== 1) throw Error();
    const bytes = await pipeline.rotate().resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 88, alphaQuality: 100, smartSubsample: true }).toBuffer();
    return { bytes, kind: "image", truncated: false };
  } catch { throw reject("Choose a readable, single-frame image of up to 32 megapixels."); }
}

// Every representation gets its own nonce and is bound to its organisation, case and purpose.
function seal(key, context, bytes) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
}

function unseal(key, context, blob) {
  const data = Buffer.from(blob);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]);
  } catch { throw new HttpError(500, "Evidence failed its integrity check."); }
}

export function evidenceStore(db, org, keysDirectory) {
  const context = (report, id, part) => JSON.stringify(["wb-evidence-v1", org.id, org.log_id, report, id, part]);
  const pinned = () => db.prepare("SELECT fingerprint FROM evidence_key WHERE singleton=1").get()?.fingerprint;
  async function withKey(create, use) {
    if (!keysDirectory) throw keyUnavailable();
    const path = join(keysDirectory, org.id + ".evidence.wbkey");
    let key;
    try {
      try { key = await readBackupKey(path); }
      catch (error) {
        if (!create || error.code !== "ENOENT" || pinned() || db.prepare("SELECT 1 FROM evidence LIMIT 1").get()) throw error;
        // Another request can win exclusive key creation. Both read the published key.
        try { await createBackupKey(path); } catch (creation) {
          try { key = await readBackupKey(path); } catch { throw creation; }
        }
        key ??= await readBackupKey(path);
      }
      const pin = pinned();
      if (pin ? pin !== sha256(key) : !create || db.prepare("SELECT 1 FROM evidence LIMIT 1").get()) throw keyUnavailable();
    } catch { key?.fill(0); throw keyUnavailable(); }
    try { return use(key); } finally { key.fill(0); }
  }

  return {
    async prepare(report, items) {
      if (!keysDirectory) throw keyUnavailable();
      const files = decodeFiles(items);
      const previews = [];
      for (const file of files) previews.push(await makePreview(file));
      return withKey(true, key => ({
        fingerprint: sha256(key),
        manifest: createHmac("sha256", key).update(JSON.stringify(files.map(f => [f.name, sha256(f.bytes)]))).digest("hex"),
        rows: files.map((file, i) => {
          const id = randomBytes(16).toString("hex");
          const preview = previews[i];
          const meta = { name: file.name, bytes: file.bytes.length, kind: preview.kind, truncated: preview.truncated };
          const encrypt = (part, bytes) => seal(key, context(report, id, part), bytes);
          return [id, report, encrypt("metadata", Buffer.from(JSON.stringify(meta))), encrypt("original", file.bytes), encrypt("preview", preview.bytes)];
        }),
      }));
    },
    insert(prepared) {
      db.prepare("INSERT OR IGNORE INTO evidence_key VALUES(1, ?)").run(prepared.fingerprint);
      if (pinned() !== prepared.fingerprint) throw keyUnavailable();
      const insert = db.prepare("INSERT INTO evidence(id,report_id,metadata,original,preview) VALUES(?,?,?,?,?)");
      for (const row of prepared.rows) insert.run(...row);
    },
    async list(report) {
      const rows = db.prepare("SELECT id, metadata FROM evidence WHERE report_id=? ORDER BY rowid").all(report);
      if (!rows.length) return [];
      return withKey(false, key => rows.map(({ id, metadata }) => ({
        id, ...JSON.parse(unseal(key, context(report, id, "metadata"), metadata)),
      })));
    },
    async read(report, id, part) {
      if (part !== "original" && part !== "preview") throw new HttpError(404, "Evidence unavailable.");
      const row = db.prepare("SELECT metadata, " + part + " AS payload FROM evidence WHERE report_id=? AND id=?").get(report, id);
      if (!row) throw new HttpError(404, "Evidence unavailable.");
      return withKey(false, key => ({
        metadata: JSON.parse(unseal(key, context(report, id, "metadata"), row.metadata)),
        bytes: unseal(key, context(report, id, part), row.payload),
      }));
    },
  };
}

export function sendEvidence(response, part, { bytes, metadata }) {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'", "Content-Length": bytes.length };
  if (part === "original") {
    headers["Content-Type"] = "application/octet-stream";
    const name = encodeURIComponent(metadata.name).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16));
    headers["Content-Disposition"] = "attachment; filename=\"evidence\"; filename*=UTF-8''" + name;
  } else if (metadata.kind === "image") {
    headers["Content-Type"] = "image/webp";
  } else {
    headers["Content-Type"] = "text/plain; charset=utf-8";
    headers["Content-Encoding"] = "gzip";
  }
  response.writeHead(200, headers);
  response.end(bytes);
}
