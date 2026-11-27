import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { verifyCaseHistory } from "../lib/case-history.mjs";
import { createInterface } from "node:readline";
import { test } from "node:test";

const passphrase = "a development passphrase";
const code = "WB-0123-4567-890A-BCDE-0123-4567";
const anonymousReport = {
  code, category: "harassment", summary: "Sample workplace concern",
  description: "This is invented sample text for the reporting workflow.",
  occurredOn: "2026-02-15", location: "Sample office", privacy: "anonymous",
  email: "should-not-be-stored@example.test",
};

async function start(directory) {
  const worker = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.mjs"], {
    env: { ...process.env, PORT: "0", WHISTLEBLOWER_DATA_DIR: directory, WHISTLEBLOWER_REVIEWER_PASSWORD: passphrase },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const closed = once(worker, "exit");
  try {
    const lines = createInterface({ input: worker.stdout });
    const base = await Promise.race([
      new Promise((resolve) => lines.on("line", (line) => {
        const match = line.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) resolve(match[0]);
      })),
      closed.then(([status]) => { throw new Error(`Server stopped before listening (exit ${status}).`); }),
    ]);
    return {
      base,
      close: async () => { worker.kill(); await closed; },
    };
  } catch (error) {
    worker.kill();
    throw error;
  }
}

test("reports persist with private access, idempotent writes and reviewer-only details", { timeout: 45_000 }, async (testContext) => {
  const directory = await mkdtemp(join(tmpdir(), "whistleblower-test-"));
  let server;
  testContext.after(async () => {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });
  server = await start(directory);
  let cookie;
  const api = async (path, body, headers = {}) => {
    const response = await fetch(`${server.base}/api${path}`, body === undefined ? { headers } : {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.base, ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };

  assert.equal((await fetch(server.base)).status, 200);
  assert.equal((await api("/reviewer/reports")).status, 401);
  assert.equal((await api("/reports", anonymousReport, { Origin: "https://example.test" })).status, 403);
  assert.equal((await api("/reports", { ...anonymousReport, occurredOn: "2026-02-31" })).status, 400);
  assert.equal((await api("/reviewer/login", { password: "wrong" })).status, 401);

  const created = await api("/reports", anonymousReport);
  assert.equal(created.status, 201);
  assert.equal((await api("/reports", anonymousReport)).data.reference, created.data.reference);
  assert.equal((await api("/reports", { ...anonymousReport, summary: "Different report" })).status, 409);
  assert.equal((await api("/track", { code: "WB-0000-0000-0000-0000-0000-0000" })).status, 404);
  const reporterView = await api("/track", { code: code.toLowerCase().replaceAll("-", "") });
  assert.equal(reporterView.data.status, "received");
  assert.equal(reporterView.headers.get("cache-control"), "no-store");
  for (const field of ["contactEmail", "description", "occurredOn", "location", "code"]) {
    assert.equal(Object.hasOwn(reporterView.data, field), false);
  }

  const signIn = async () => {
    const login = await api("/reviewer/login", { password: passphrase });
    assert.equal(login.status, 200);
    const header = login.headers.get("set-cookie");
    assert.match(header, /HttpOnly; SameSite=Strict/);
    return header.split(";")[0];
  };
  cookie = await signIn();
  const reviewerApi = (path, body) => api(`/reviewer${path}`, body, { Cookie: cookie });
  const casePath = `/reports/${created.data.reference}`;
  assert.equal((await reviewerApi("/reports")).data.total, 1);
  const details = (await reviewerApi(casePath)).data;
  assert.equal(details.contactEmail, null);
  assert.equal(details.description, anonymousReport.description);
  assert.equal(Object.hasOwn(details, "code"), false);

  const namedCode = "WB-1345-4567-892B-BCDE-0D23-4567";
  const named = await api("/reports", { ...anonymousReport, code: namedCode, privacy: "contact", email: "contact@example.test" });
  assert.equal(named.status, 201);
  assert.equal((await reviewerApi(`/reports/${named.data.reference}`)).data.contactEmail, "contact@example.test");
  assert.equal(Object.hasOwn((await api("/track", { code: namedCode })).data, "contactEmail"), false);

  const message = { code, clientId: "0867ddb6-a35f-4154-b531-74c634a41c56", message: "Sample follow-up." };
  assert.equal((await api("/track/message", message)).status, 200);
  assert.equal((await api("/track/message", message)).data.events.length, 2);
  assert.equal((await reviewerApi(`${casePath}/status`, { status: "reviewing" })).data.status, "reviewing");
  assert.equal((await reviewerApi(`${casePath}/message`, { ...message, message: "Sample reviewer reply." })).status, 200);
  assert.equal((await reviewerApi("/reports?status=reviewing")).data.total, 1);

  await server.close();
  server = await start(directory);
  assert.equal((await reviewerApi(casePath)).status, 401);
  const persisted = (await api("/track", { code })).data;
  assert.equal(persisted.status, "reviewing");
  assert.equal(persisted.events.at(-1).value, "Sample reviewer reply.");
  cookie = await signIn();
  assert.equal((await reviewerApi(`${casePath}/status`, { status: "resolved" })).data.status, "resolved");
  assert.equal((await api("/track/message", { ...message, clientId: "0460c9b4-e8ad-44ff-8127-235f16cbed12" })).status, 409);
  assert.equal((await api("/track/message", message)).status, 200);
  assert.equal((await reviewerApi("/logout", {})).status, 200);
  assert.equal((await reviewerApi(casePath)).status, 401);

  const db = new DatabaseSync(join(directory, "whistleblower.sqlite"), { readOnly: true });
  try { assert.equal(verifyCaseHistory(db).entries, 8); } finally { db.close(); }
});
