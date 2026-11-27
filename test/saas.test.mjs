import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
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

async function startSaas(context) {
  const temp = await mkdtemp(join(tmpdir(), "whistleblower-saas-test-"));
  const root = join(temp, "data");
  const archive = join(temp, "archive");
  const keys = join(temp, "keys");
  const env = {
    ...process.env, PORT: "0", WHISTLEBLOWER_DATA_DIR: root, WHISTLEBLOWER_ARCHIVE_DIR: archive,
    WHISTLEBLOWER_KEYS_DIR: keys, WHISTLEBLOWER_PLATFORM_ADMIN_PASSWORD: pretendPlatformPassword,
    WHISTLEBLOWER_ORIGIN: "",
  };
  let server;
  let closed;
  context.after(async () => {
    if (server && server.exitCode === null) { server.kill(); await closed; }
    await rm(temp, { recursive: true, force: true });
  });
  await run(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/platform.mjs", "create-admin", platformEmail], { env });
  server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.mjs", "--saas"], {
    env, stdio: ["ignore", "pipe", "ignore"],
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

test("SaaS roles, reports, case credentials, backups and proofs never cross organisation boundaries", { timeout: 60_000 }, async (context) => {
  const { base, root, archive, keys, env, temp } = await startSaas(context);
  const api = async (path, body, cookie, origin = base) => {
    const headers = { ...(cookie ? { Cookie: cookie } : {}) };
    const response = await fetch(base + path, body === undefined ? { headers } : {
      method: "POST", headers: { ...headers, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    return { status: response.status, data: await response.json(), setCookie, cookie: setCookie?.split(";")[0] };
  };
  const cli = (...args) => run(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/integrity.mjs", ...args], { env });
  const fail = (promise, pattern) => assert.rejects(promise, (error) => error.code === 1 && pattern.test(error.stderr));

  const landing = await fetch(base);
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /admin\.js/);
  assert.equal((await fetch(base + "/admin.js")).status, 200);
  assert.equal((await api(central + "/workspaces")).status, 401);
  const platformSession = await api(central + "/login", { email: platformEmail, password: pretendPlatformPassword });
  assert.equal(platformSession.status, 200);
  assert.match(platformSession.setCookie, /Path=\/platform\/api; HttpOnly; SameSite=Strict/);
  const p = platformSession.cookie;

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
