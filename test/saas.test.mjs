import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import { createEncryptedBackup, restoreEncryptedBackup } from "../lib/backup.mjs";
import { verifyCaseHistory } from "../lib/case-history.mjs";
import { evidenceStore } from "../lib/evidence.mjs";
import { runAnchorSweep } from "../lib/anchors.mjs";
import { findOrganisation, openRegistry, tenantDatabasePath, tenantDirectory } from "../lib/tenants.mjs";

const run = promisify(execFile);
const password = "fixture user passphrase";
const pretendPlatformPassword = "fixture platform passphrase";
const platformEmail = "operator@example.test";
const central = "/platform/api/admin";
const tenant = (slug, path) => `/o/${slug}/api/${path}`;
const commonSecret = "1234-A0CD-5678-BEEF-0789-A1FA";
const code = (slug) => `WB/${slug}/${commonSecret}`;
const sample = (slug) => ({
  code: code(slug), category: "other", summary: `Fictional ${slug} concern`,
  description: "Invented sample report for the tenant isolation test.", privacy: "anonymous",
});

async function startSaas(context, enableEvidence = false) {
  const temp = await mkdtemp(join(tmpdir(), "whistleblower-saas-test-"));
  const root = join(temp, "data");
  const archive = join(temp, "archive");
  const keys = join(temp, "keys");
  const env = {
    ...process.env, PORT: "0", WHISTLEBLOWER_DATA_DIR: root, WHISTLEBLOWER_ARCHIVE_DIR: archive,
    WHISTLEBLOWER_KEYS_DIR: keys, WHISTLEBLOWER_PLATFORM_ADMIN_PASSWORD: pretendPlatformPassword,
    WHISTLEBLOWER_ORIGIN: "", WHISTLEBLOWER_OTS_BIN: join(temp, "test-ots"),
  };
  let server;
  let closed;
  context.after(async () => {
    if (server && server.exitCode === null) { server.kill(); await closed; }
    await rm(temp, { recursive: true, force: true });
  });
  await run(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/platform.mjs", "create-admin", platformEmail], { env });
  // This fixture tests operator-generated keys. Scheduled key provisioning has its own integration test.
  const serverEnv = { ...env };
  if (enableEvidence) delete serverEnv.WHISTLEBLOWER_ARCHIVE_DIR;
  else delete serverEnv.WHISTLEBLOWER_KEYS_DIR;
  server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.mjs", "--saas"], {
    env: serverEnv, stdio: ["ignore", "pipe", "ignore"],
  });
  closed = once(server, "exit");
  const lines = createInterface({ input: server.stdout });
  const base = await Promise.race([
    new Promise((resolve) => lines.on("line", (line) => {
      const match = line.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    })),
    closed.then(([status]) => { throw new Error(`SaaS server exited before listening (${status}).`); }),
  ]);
  return { root, archive, keys, env, base, temp };
}

function apiFor(base) {
  return async (path, body, cookie, origin = base) => {
    const headers = { ...(cookie ? { Cookie: cookie } : {}) };
    const response = await fetch(base + path, body === undefined ? { headers } : {
      method: "POST", headers: { ...headers, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    return { status: response.status, data: await response.json(), setCookie, cookie: setCookie?.split(";")[0] };
  };
}

test("SaaS roles, reports, case credentials, backups and proofs never cross organisation boundaries", { timeout: 60_000 }, async (context) => {
  const { base, root, archive, keys, env, temp } = await startSaas(context);
  const api = apiFor(base);
  const cli = (...args) => run(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/integrity.mjs", ...args], { env });
  const fail = (promise, pattern) => assert.rejects(promise, (error) => error.code === 1 && pattern.test(error.stderr));

  const landing = await fetch(base);
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /admin\.js/);
  assert.equal((await fetch(base + "/admin.js")).status, 200);
  assert.equal((await api(central + "/workspaces")).status, 401);
  assert.equal((await api(central + "/backups")).status, 401);
  const platformSession = await api(central + "/login", { email: platformEmail, password: pretendPlatformPassword });
  assert.equal(platformSession.status, 200);
  assert.match(platformSession.setCookie, /Path=\/platform\/api; HttpOnly; SameSite=Strict/);
  const p = platformSession.cookie;
  assert.equal((await api(central + "/backups", undefined, p)).data.state, "unconfigured");

  const provision = (slug, adminEmail, cookie = p) => api(central + "/workspaces", {
    name: `Organisation ${slug}`, slug, adminEmail,
  }, cookie);
  const alpha = await provision("alpha-org", "same-admin@example.test");
  const beta = await provision("beta-org", "same-admin@example.test");
  assert.equal(alpha.status, 201);
  assert.equal(beta.status, 201);
  assert.equal((await provision("alpha-org", "other@example.test")).status, 409);
  assert.equal(Object.hasOwn(alpha.data.organisation, "log_id"), false);
  assert.deepEqual((await api(central + "/workspaces", undefined, p)).data.organisations.map(({ slug }) => slug), ["alpha-org", "beta-org"]);
  assert.equal((await api(tenant("alpha-org", "admin/settings"), undefined, p)).status, 401);
  assert.equal((await api(tenant("alpha-org", "reviewer/reports"), undefined, p)).status, 401);

  assert.equal((await api(tenant("alpha-org", "admin/anchoring"), undefined, p)).status, 401);
  const oldAlphaInvite = alpha.data.invite.code;
  const renewed = await api(central + "/workspaces/alpha-org/setup-invite", { email: "same-admin@example.test" }, p);
  assert.equal(renewed.status, 200);
  const accept = (slug, code) => api(tenant(slug, "auth/accept"), { code, password });
  assert.equal((await accept("alpha-org", oldAlphaInvite)).status, 400);
  assert.equal((await accept("beta-org", renewed.data.invite.code)).status, 400);
  const alphaAdmin = await accept("alpha-org", renewed.data.invite.code);
  const betaAdmin = await accept("beta-org", beta.data.invite.code);
  assert.equal(alphaAdmin.status, 201);
  assert.equal(betaAdmin.status, 201);
  assert.equal(alphaAdmin.data.role, "organisation_admin");
  assert.equal((await api(central + "/backups", undefined, alphaAdmin.cookie)).status, 401);
  assert.equal((await api(tenant("alpha-org", "admin/backups"), undefined, alphaAdmin.cookie)).status, 404);
  assert.match(alphaAdmin.setCookie, /Path=\/o\/alpha-org\/api; HttpOnly; SameSite=Strict/);
  assert.equal((await accept("alpha-org", renewed.data.invite.code)).status, 400);
  assert.equal((await api(central + "/workspaces/alpha-org/setup-invite", { email: "someone@example.test" }, p)).status, 409);
  assert.equal((await provision("forbidden", platformEmail, alphaAdmin.cookie)).status, 401);
  assert.equal((await api(tenant("beta-org", "admin/settings"), undefined, alphaAdmin.cookie)).status, 401);
  assert.equal((await api(tenant("alpha-org", "reviewer/reports"), undefined, alphaAdmin.cookie)).status, 401);

  const inviteReviewer = (slug, cookie, role = "reviewer") => api(tenant(slug, "admin/invites"), { email: "reviewer@example.test", role }, cookie);
  assert.equal((await inviteReviewer("alpha-org", alphaAdmin.cookie, "platform_admin")).status, 400);
  const ai = await inviteReviewer("alpha-org", alphaAdmin.cookie);
  const bi = await inviteReviewer("beta-org", betaAdmin.cookie);
  const ar = await accept("alpha-org", ai.data.invite.code);
  const br = await accept("beta-org", bi.data.invite.code);
  assert.equal(ar.data.role, "reviewer");
  assert.equal(br.data.role, "reviewer");
  assert.equal((await api(tenant("alpha-org", "admin/settings"), undefined, ar.cookie)).status, 401);
  const betaTeam = await api(tenant("beta-org", "admin/settings"), undefined, betaAdmin.cookie);
  const betaReviewer = betaTeam.data.accounts.find(({ role }) => role === "reviewer");
  assert.equal((await api(tenant("alpha-org", `admin/members/${betaReviewer.id}/revoke`), {}, alphaAdmin.cookie)).status, 404);
  assert.equal((await api(tenant("beta-org", "reviewer/reports"), undefined, br.cookie)).status, 200);

  assert.equal((await api(tenant("alpha-org", "reports"), sample("alpha-org"), null, "https://other.example.test")).status, 403);
  assert.equal((await api(tenant("beta-org", "reports"), sample("alpha-org"))).status, 400);
  const reportA = await api(tenant("alpha-org", "reports"), { ...sample("alpha-org"), organisation: "beta-org" });
  const reportB = await api(tenant("beta-org", "reports"), sample("beta-org"));
  assert.equal(reportA.status, 201);
  assert.equal(reportB.status, 201);
  assert.equal((await api(tenant("beta-org", "track"), { code: code("alpha-org") })).status, 404);
  assert.equal((await api(tenant("alpha-org", "track"), { code: code("beta-org") })).status, 404);
  assert.equal((await api(tenant("alpha-org", "track"), { code: code("alpha-org") })).data.summary, "Fictional alpha-org concern");
  assert.equal((await api(tenant("beta-org", "reviewer/reports"), undefined, ar.cookie)).status, 401);
  assert.equal((await api(tenant("beta-org", `reviewer/reports/${reportA.data.reference}`), undefined, br.cookie)).status, 404);
  const inbox = await api(tenant("beta-org", "reviewer/reports"), undefined, br.cookie);
  assert.deepEqual(inbox.data.reports.map(({ reference }) => reference), [reportB.data.reference]);

  const closed = await api(tenant("alpha-org", "admin/settings"), { name: "Alpha & Co.", intakeOpen: false }, alphaAdmin.cookie);
  assert.equal(closed.status, 200);
  const portalHtml = await (await fetch(base + "/o/alpha-org/")).text();
  assert.match(portalHtml, /content="Alpha &amp; Co\."/);
  assert.equal((await api(tenant("alpha-org", "reports"), sample("alpha-org"))).status, 403);
  assert.equal((await api(tenant("alpha-org", "track"), { code: code("alpha-org") })).status, 200);

  const registry = openRegistry(root, { readOnly: true });
  const rowA = findOrganisation(registry, "alpha-org");
  const rowB = findOrganisation(registry, "beta-org");
  registry.close();
  assert.notEqual(tenantDatabasePath(root, rowA), tenantDatabasePath(root, rowB));
  assert.notEqual(rowA.log_id, rowB.log_id);
  await fail(cli("verify"), /require --org/);
  await fail(cli("verify", "--org", "alpha-org", "--db", tenantDatabasePath(root, rowB)), /Usage/);
  await fail(cli("checkpoint", "../foreign.json", "--org", "alpha-org"), /simple organisation artifact/);

  for (const slug of ["alpha-org", "beta-org"]) {
    await cli("keygen", "--org", slug);
    await cli("checkpoint", "same.json", "--org", slug);
    await cli("backup", "same.wbbackup", "--org", slug, "--checkpoint", "same.json");
  }
  const backup = (row, name) => join(archive, row.id, "backups", name);
  const checkpoint = (row, name) => join(archive, row.id, "checkpoints", name);
  assert.notDeepEqual(await readFile(join(keys, rowA.id + ".wbkey")), await readFile(join(keys, rowB.id + ".wbkey")));
  assert.notDeepEqual(await readFile(checkpoint(rowA, "same.json")), await readFile(checkpoint(rowB, "same.json")));
  await cli("restore", "same.wbbackup", "drill", "--org", "alpha-org", "--checkpoint", "same.json");
  const database = new DatabaseSync(join(tenantDirectory(root, rowA), "recovery", "drill", "whistleblower.sqlite"), { readOnly: true });
  try { assert.deepEqual(database.prepare("SELECT id FROM reports").all().map(({ id }) => id), [reportA.data.reference]); }
  finally { database.close(); }

  await copyFile(backup(rowA, "same.wbbackup"), backup(rowB, "copied.wbbackup"));
  await copyFile(join(keys, rowA.id + ".wbkey"), join(keys, rowB.id + ".wbkey"));
  await fail(cli("restore", "copied.wbbackup", "forbidden", "--org", "beta-org"), /authentication failed/);
  await assert.rejects(stat(join(tenantDirectory(root, rowB), "recovery", "forbidden", "whistleblower.sqlite")), { code: "ENOENT" });
  await copyFile(checkpoint(rowA, "same.json"), checkpoint(rowB, "foreign.json"));
  await fail(cli("verify", "--checkpoint", "foreign.json", "--org", "beta-org"), /different organisation/);
  await fail(cli("upgrade", "foreign.json", "--org", "beta-org"), /different organisation/);

  const ots = join(temp, "verify-ots.sh");
  await writeFile(ots, '#!/bin/sh\nif [ "$2" = info ]; then cat "$3"; else exit 1; fi\n', { mode: 0o700 });
  const digestA = createHash("sha256").update(await readFile(checkpoint(rowA, "same.json"))).digest("hex");
  await writeFile(checkpoint(rowB, "same.json.ots"), `File sha256 hash: ${digestA}\n`);
  await fail(run(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/integrity.mjs",
    "verify-anchor", "same.json", "--org", "beta-org"], { env: { ...env, WHISTLEBLOWER_OTS_BIN: ots } }), /proof does not belong/);

  const access = (active) => api(central + "/workspaces/beta-org/access", { active }, p);
  assert.equal((await access(false)).status, 200);
  assert.equal((await api(tenant("beta-org", "reviewer/reports"), undefined, br.cookie)).status, 404);
  assert.equal((await api(tenant("beta-org", "track"), { code: code("beta-org") })).status, 404);
  assert.equal((await api(tenant("alpha-org", "reviewer/reports"), undefined, ar.cookie)).status, 200);
  assert.equal((await access(true)).status, 200);
  assert.equal((await api(tenant("beta-org", "reviewer/reports"), undefined, br.cookie)).status, 401);
  assert.equal((await api(tenant("beta-org", "track"), { code: code("beta-org") })).status, 200);
  assert.equal((await fetch(base + "/platform.sqlite")).status, 404);
  assert.equal((await fetch(base + "/o/alpha-org/whistleblower.sqlite")).status, 404);
});

test("automatic tenant anchors resume, verify their own case history and serve authenticated proof pairs", async (context) => {
  const { base, root, archive, temp, env } = await startSaas(context);
  const api = apiFor(base);
  const platformSession = await api(central + "/login", { email: platformEmail, password: pretendPlatformPassword });
  async function workspace(slug) {
    const created = await api(central + "/workspaces", { name: slug, slug, adminEmail: "admin@example.test" }, platformSession.cookie);
    const admin = await api(tenant(slug, "auth/accept"), { code: created.data.invite.code, password });
    const registry = openRegistry(root);
    try { return { org: findOrganisation(registry, slug), admin }; }
    finally { registry.close(); }
  }
  const { org: rowA, admin: alphaAdmin } = await workspace("alpha-org");
  const { org: rowB, admin: betaAdmin } = await workspace("beta-org");
  const invited = await api(tenant(rowA.slug, "admin/invites"), { email: "reviewer@example.test", role: "reviewer" }, alphaAdmin.cookie);
  const reviewer = await api(tenant(rowA.slug, "auth/accept"), { code: invited.data.invite.code, password });
  const endpoint = (org, suffix = "") => tenant(org.slug, "admin/anchoring" + suffix);
  const status = (org, admin) => api(endpoint(org), undefined, admin.cookie).then(response => response.data);
  const fetchFile = (org, admin, kind) => fetch(base + endpoint(org, "/2/" + kind), { headers: { Cookie: admin.cookie } });
  assert.equal((await status(rowA, alphaAdmin)).state, "waiting");
  assert.equal((await api(endpoint(rowA), undefined, reviewer.cookie)).status, 401);
  assert.equal((await fetchFile(rowA, betaAdmin, "receipt")).status, 401);
  assert.equal((await fetchFile(rowA, alphaAdmin, "receipt")).status, 404);

  const modeFile = join(temp, "calendar-state");
  const log = join(temp, "stamp-log");
  const client = env.WHISTLEBLOWER_OTS_BIN;
  await writeFile(modeFile, "pending");
  await writeFile(client, `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const [cache, command, ...args] = process.argv.slice(2);
const file = args.at(-1);
const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8");
if(cache !== "--no-cache") process.exit(2);
if (command === "stamp") {
  const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  fs.writeFileSync(file + ".ots", JSON.stringify({ digest }));
  fs.appendFileSync(${JSON.stringify(log)}, digest + "\\n");
} else {
  const proof = JSON.parse(fs.readFileSync(file));
  if (command === "info") console.log("File sha256 hash: " + proof.digest);
  if (command === "upgrade") {
    if(mode === "pending") { console.error("Pending confirmation in Bitcoin blockchain\\nFailed! Timestamp not complete"); process.exit(1); }
    fs.writeFileSync(file, JSON.stringify({...proof, attested: true}));
  }
  if (command === "verify") {
    if (!proof.attested || mode === "offline" || args[1] !== proof.digest) process.exit(1);
    console.log("Success! Bitcoin block 123456 attests existence");
  }
}
`, { mode: 0o700 });
  const priorArchive = process.env.WHISTLEBLOWER_ARCHIVE_DIR;
  const priorOts = process.env.WHISTLEBLOWER_OTS_BIN;
  process.env.WHISTLEBLOWER_ARCHIVE_DIR = archive;
  process.env.WHISTLEBLOWER_OTS_BIN = client;
  let registry = openRegistry(root);
  let time = Date.now() + 3600_000;
  const sweep = () => runAnchorSweep(registry, root, { now: () => time });
  try {
    await sweep();
    assert.equal((await status(rowA, alphaAdmin)).state, "waiting");
    for (const org of [rowA, rowB]) assert.equal((await api(tenant(org.slug, "reports"), sample(org.slug))).status, 201);
    time += 60_000;
    await Promise.all([sweep(), sweep()]);
    for (const [org, admin] of [[rowA, alphaAdmin], [rowB, betaAdmin]]) {
      assert.equal((await status(org, admin)).state, "pending");
      assert.equal((await status(org, admin)).verified, null);
    }
    // Simulate loss of the state transition after the first receipt reached disk.
    registry.prepare("UPDATE anchor_jobs SET phase='queued',next_at=0 WHERE org=?").run(rowA.id);
    registry.close();
    registry = openRegistry(root);
    await sweep();
    assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2);
    time += 15 * 60_000;
    await sweep();
    assert.equal((await status(rowA, alphaAdmin)).state, "pending");

    await writeFile(modeFile, "offline");
    time += 15 * 60_000;
    await sweep();
    const unavailable = await status(rowA, alphaAdmin);
    assert.equal(unavailable.state, "retrying");
    assert.equal(unavailable.phase, "verifying");
    assert.equal(unavailable.verified, null);
    await writeFile(modeFile, "confirmed");
    time += 15 * 60_000;
    await sweep();
    const verified = await status(rowA, alphaAdmin);
    assert.deepEqual(verified.verified, { entries: 2, block: 123456, at: time });
    assert.equal(verified.state, "verified");
    const receipt = await fetchFile(rowA, alphaAdmin, "receipt");
    assert.equal(receipt.status, 200);
    assert.match(receipt.headers.get("content-disposition"), /auto-2\.json\.ots/);
    const digest = createHash("sha256").update(Buffer.from(await (await fetchFile(rowA, alphaAdmin, "checkpoint")).arrayBuffer())).digest("hex");
    assert.equal(JSON.parse(await receipt.text()).digest, digest);
    const fileA = join(archive, rowA.id, "checkpoints", "auto-2.json.ots");
    const fileB = join(archive, rowB.id, "checkpoints", "auto-2.json.ots");
    await copyFile(fileA, fileB);
    assert.equal((await fetchFile(rowB, betaAdmin, "receipt")).status, 409);
    assert.equal((await fetchFile(rowA, alphaAdmin, "receipt")).status, 200);

    // A new report gets its own job; the earlier block still refers to exactly two entries.
    const nextCode = code("beta-org").replace(commonSecret, "4321-A0CD-5678-BEEF-0789-A1FA");
    assert.equal((await api(tenant(rowB.slug, "reports"), { ...sample(rowB.slug), code: nextCode })).status, 201);
    registry.prepare("UPDATE organisations SET active=0 WHERE id=?").run(rowB.id);
    time += 3600_000;
    await sweep();
    assert.equal(registry.prepare("SELECT count(*) n FROM anchor_jobs WHERE org=?").get(rowB.id).n, 1);
    registry.prepare("UPDATE organisations SET active=1 WHERE id=?").run(rowB.id);
    await sweep();
    const next = await status(rowB, betaAdmin);
    assert.equal(next.entries, 4);
    assert.equal(next.state, "pending");
    assert.deepEqual(next.verified, verified.verified);
    const cases = new DatabaseSync(tenantDatabasePath(root, rowB));
    try { cases.prepare("UPDATE reports SET description='modified' WHERE code_hash=(SELECT code_hash FROM reports LIMIT 1)").run(); }
    finally { cases.close(); }
    time += 3600_000;
    await sweep();
    assert.equal((await status(rowB, betaAdmin)).state, "check_failed");
    assert.equal((await status(rowB, betaAdmin)).verified.entries, 2);
    assert.equal((await status(rowA, alphaAdmin)).state, "verified");
  } finally {
    registry.close();
    if (priorArchive === undefined) delete process.env.WHISTLEBLOWER_ARCHIVE_DIR; else process.env.WHISTLEBLOWER_ARCHIVE_DIR = priorArchive;
    if (priorOts === undefined) delete process.env.WHISTLEBLOWER_OTS_BIN; else process.env.WHISTLEBLOWER_OTS_BIN = priorOts;
  }
});


test("organisation evidence preserves exact originals, protected previews, history and recoverability", { timeout: 60_000 }, async context => {
  const { base, root, keys, temp } = await startSaas(context, true);
  const api = apiFor(base);
  const platformSession = await api(central + "/login", { email: platformEmail, password: pretendPlatformPassword });
  const makeTeam = async slug => {
    const org = await api(central + "/workspaces", { name: slug, slug, adminEmail: "admin@example.test" }, platformSession.cookie);
    const accept = code => api(tenant(slug, "auth/accept"), { code, password });
    const admin = await accept(org.data.invite.code);
    const invite = await api(tenant(slug, "admin/invites"), { email: "reviewer@example.test", role: "reviewer" }, admin.cookie);
    const reviewer = await accept(invite.data.invite.code);
    return { admin: admin.cookie, reviewer: reviewer.cookie };
  };
  const a = await makeTeam("alpha");
  const b = await makeTeam("beta");
  const registry = openRegistry(root, { readOnly: true });
  const org = findOrganisation(registry, "alpha");
  const beta = findOrganisation(registry, "beta");
  registry.close();

  const image = await sharp({ create: { width: 2100, height: 1050, channels: 3, background: "#587896" } })
    .withMetadata({ orientation: 6 }).jpeg({ quality: 96 }).toBuffer();
  const content = "Fictional observation 你好 — <b>sample</b>\r\n".repeat(1400);
  const originalText = Buffer.from("\uFEFF" + content);
  const encode = (name, bytes) => ({ name, data: bytes.toString("base64") });
  const files = [encode("private-photo.jpg", image), encode("private-記録.txt", originalText)];
  const submit = (slug, evidence, extra = {}) => api(tenant(slug, "reports/with-evidence"), { ...sample(slug), evidence, ...extra });
  const [first, retry] = await Promise.all([submit("alpha", files), submit("alpha", files)]);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(retry.status, 201);
  assert.deepEqual(retry.data, first.data);
  assert.equal((await submit("alpha", [files[1]])).status, 409);
  const webp = await sharp(image).resize(40, 20).webp().toBuffer();
  assert.equal((await submit("beta", [files[1], encode("sample.webp", webp)])).status, 201);
  const ref = first.data.reference;
  const detailPath = tenant("alpha", "reviewer/reports/" + ref);
  const detail = (await api(detailPath, undefined, a.reviewer)).data;
  assert.deepEqual(detail.evidence.map(f => f.name), files.map(f => f.name));
  assert.equal(detail.evidence[1].truncated, true);
  const tracked = await api(tenant("alpha", "track"), { code: code("alpha") });
  assert.equal(tracked.data.evidence, undefined);
  const filePath = (id, part) => detailPath + "/evidence/" + id + "/" + part;
  const get = (path, cookie) => fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });
  const id = detail.evidence[0].id;
  for (const cookie of [undefined, a.admin, platformSession.cookie, b.reviewer]) {
    for (const part of ["original", "preview"]) assert.equal((await get(filePath(id, part), cookie)).status, 401);
  }
  assert.equal((await get(filePath(id, "original").replace("/alpha/", "/beta/"), b.reviewer)).status, 404);
  for (const [i, expected] of [image, originalText].entries()) {
    const res = await get(filePath(detail.evidence[i].id, "original"), a.reviewer);
    assert.match(res.headers.get("content-disposition"), /^attachment;/);
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), expected);
  }
  const preview = await get(filePath(id, "preview"), a.reviewer);
  assert.equal(preview.headers.get("content-type"), "image/webp");
  const meta = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height, meta.exif], ["webp", 960, 1920, undefined]);
  const excerpt = await get(filePath(detail.evidence[1].id, "preview"), a.reviewer);
  assert.equal(excerpt.headers.get("content-encoding"), "gzip");
  assert.match(excerpt.headers.get("content-type"), /^text\/plain/);
  assert.equal(await excerpt.text(), content.slice(0, 32768));

  for (const bad of [
    [files[0], encode("bad.txt", Buffer.from([0xc0, 0x80]))], [encode("fake.png", Buffer.from("<svg/>"))],
    [encode("binary.txt", Buffer.from([0, 1, 2]))], [encode("truncated.jpg", image.subarray(0, 12))],
    [encode("too-large.txt", Buffer.alloc(4 * 1024 ** 2 + 1))], Array(4).fill(files[1]),
  ]) assert.equal((await submit("alpha", bad, { code: "WB/alpha/ABCDEFABCDEFABCDEFABCDEF" })).status, 400);

  const path = tenantDatabasePath(root, org);
  const db = new DatabaseSync(path);
  context.after(() => db.close());
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reports").get().n, 1);
  const rows = db.prepare("SELECT * FROM evidence ORDER BY rowid").all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    for (const col of ["metadata", "preview", "original"]) {
      const encrypted = Buffer.from(row[col]);
      assert.equal(encrypted.includes(Buffer.from("private-")), false);
      assert.equal(encrypted.includes(Buffer.from("Fictional observation")), false);
      assert.equal(encrypted.includes(image.subarray(0, 30)), false);
    }
  }
  const checkpoint = verifyCaseHistory(db);
  const key = randomBytes(32);
  const archive = join(temp, "evidence.wbbackup");
  const restored = join(temp, "restored.sqlite");
  await createEncryptedBackup(path, archive, key, checkpoint, org.log_id);
  await restoreEncryptedBackup(archive, restored, key, checkpoint, org.log_id);
  const recovery = new DatabaseSync(restored, { readOnly: true });
  try {
    const store = evidenceStore(recovery, org, keys);
    assert.deepEqual((await store.read(ref, id, "original")).bytes, image);
    assert.deepEqual((await store.read(ref, detail.evidence[1].id, "original")).bytes, originalText);
    assert.deepEqual(verifyCaseHistory(recovery, checkpoint), checkpoint);
  } finally { recovery.close(); }

  const keyPath = join(keys, org.id + ".evidence.wbkey");
  const originalKey = await readFile(keyPath);
  const otherKey = await readFile(join(keys, beta.id + ".evidence.wbkey"));
  assert.notDeepEqual(originalKey, otherKey);
  await writeFile(keyPath, otherKey);
  assert.equal((await get(filePath(id, "original"), a.reviewer)).status, 503);
  await rm(keyPath);
  assert.equal((await submit("alpha", [files[1]])).status, 503);
  await assert.rejects(stat(keyPath), { code: "ENOENT" });
  await writeFile(keyPath, originalKey, { mode: 0o600 });

  db.prepare("UPDATE evidence SET original=preview WHERE id=?").run(id);
  assert.equal((await get(filePath(id, "original"), a.reviewer)).status, 500);
  assert.throws(() => verifyCaseHistory(db, checkpoint), /integrity failure/);
  db.prepare("DELETE FROM evidence WHERE id=?").run(id);
  assert.throws(() => verifyCaseHistory(db, checkpoint), /integrity failure/);
});
