import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { accessSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { categories, statuses } from "./public/catalog.js";

process.umask(0o077);

const root = fileURLToPath(new URL(".", import.meta.url));
const demo = process.argv.includes("--demo");
const dataDirectory = resolve(process.env.WHISTLEBLOWER_DATA_DIR || join(root, ".data"));
const host = "127.0.0.1";
const port = Number(process.env.PORT || 4310);
const sessionSeconds = 12 * 60 * 60;
const configuredPassword = demo ? randomBytes(18).toString("base64url") : process.env.WHISTLEBLOWER_REVIEWER_PASSWORD ?? null;
if (configuredPassword !== null && (configuredPassword.length < 14 || configuredPassword.length > 512)) {
  throw new Error("WHISTLEBLOWER_REVIEWER_PASSWORD must be 14–512 characters.");
}
const passwordSalt = randomBytes(16);
const passwordHash = configuredPassword === null ? null : scryptSync(configuredPassword, passwordSalt, 64);
const derivePassword = promisify(scrypt);
if (!demo) mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });

const db = new DatabaseSync(demo ? ":memory:" : join(dataDirectory, "whistleblower.sqlite"));
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, submission_hash TEXT NOT NULL,
    category TEXT NOT NULL, summary TEXT NOT NULL, description TEXT NOT NULL,
    occurred_on TEXT, location TEXT, contact_email TEXT, status TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id), client_id TEXT,
    kind TEXT NOT NULL, actor TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(report_id, actor, client_id)
  );
  CREATE INDEX IF NOT EXISTS reports_updated_at ON reports(updated_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS events_by_report ON events(report_id, id);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
  );
  DELETE FROM sessions;
`);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const normalizeCode = (value) => typeof value === "string" && /^WB[\s-]*[0-9A-F\s-]{24,60}$/i.test(value.trim())
  ? value.trim().replace(/[\s-]/g, "").slice(2).toUpperCase()
  : "";
const hasStatus = (status) => Object.hasOwn(statuses, status);
const publicPaths = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/catalog.js", ["catalog.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/assets/hero.webp", ["assets/hero.webp", "image/webp"]],
  ["/assets/portal-icons.png", ["assets/portal-icons.png", "image/png"]],
  ["/assets/portal-icons-white.png", ["assets/portal-icons-white.png", "image/png"]],
  ["/assets/favicon.png", ["assets/favicon.png", "image/png"]],
]);

const eventInsert = db.prepare("INSERT INTO events (report_id, client_id, kind, actor, value, created_at) VALUES (?, ?, ?, ?, ?, ?)");
const eventList = db.prepare("SELECT kind, actor, value, created_at AS createdAt FROM events WHERE report_id = ? ORDER BY id");
const reportById = db.prepare("SELECT * FROM reports WHERE id = ?");
const reportByCode = db.prepare("SELECT * FROM reports WHERE code_hash = ?");
const rateLimits = new Map();
const purgeLimits = setInterval(() => {
  for (const [key, entry] of rateLimits) if (entry.until < Date.now()) rateLimits.delete(key);
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
}, 60_000);
purgeLimits.unref();

class HttpError extends Error {
  constructor(status, message, field) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

function transaction(run) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function limit(request, scope, count, milliseconds) {
  const key = `${scope}:${request.socket.remoteAddress}`;
  const time = Date.now();
  let entry = rateLimits.get(key);
  if (!entry || entry.until <= time) {
    entry = { until: time + milliseconds, count: 0 };
    rateLimits.set(key, entry);
  }
  if (entry.count >= count) throw new HttpError(429, "Too many attempts. Wait a few minutes and try again.");
  entry.count += 1;
}

function checkedText(body, key, minimum, maximum, label) {
  const raw = body[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  if ((raw != null && typeof raw !== "string") || value.length < minimum || value.length > maximum) {
    const message = minimum > 0
      ? `Enter ${label} using ${minimum}–${maximum} characters.`
      : `Use at most ${maximum} characters for ${label}.`;
    throw new HttpError(400, message, key);
  }
  return value;
}

async function readBody(request) {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
    throw new HttpError(415, "Send the request as JSON.");
  }
  const maximum = 128 * 1024;
  if (Number(request.headers["content-length"]) > maximum) {
    request.resume();
    throw new HttpError(413, "This request is too large.");
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length <= maximum) chunks.push(chunk);
  }
  if (length > maximum) throw new HttpError(413, "This request is too large.");
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || Array.isArray(body) || typeof body !== "object") throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "The request could not be read. Try again.");
  }
}

function newReport(body) {
  if (!categories.some(({ id }) => id === body.category)) {
    throw new HttpError(400, "Choose a concern category.", "category");
  }
  const code = normalizeCode(body.code);
  if (!/^[0-9A-F]{24}$/.test(code)) throw new HttpError(400, "A case code could not be created. Try again.");
  const summary = checkedText(body, "summary", 5, 100, "a short summary");
  const description = checkedText(body, "description", 10, 5000, "what happened");
  const date = checkedText(body, "occurredOn", 0, 10, "the date");
  const location = checkedText(body, "location", 0, 120, "the location");
  if (date) {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== date) {
      throw new HttpError(400, "Enter a valid date.", "occurredOn");
    }
  }
  if (!["anonymous", "contact"].includes(body.privacy)) {
    throw new HttpError(400, "Choose how you want to share your identity.", "privacy");
  }
  const email = body.privacy === "contact" ? checkedText(body, "email", 3, 254, "your email address") : "";
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "Enter a valid email address.", "email");
  }
  const codeHash = sha256(code);
  const values = [body.category, summary, description, date || null, location || null, email || null];
  const submissionHash = sha256(JSON.stringify(values));
  return transaction(() => {
    const prior = reportByCode.get(codeHash);
    if (prior) {
      if (prior.submission_hash !== submissionHash) throw new HttpError(409, "This case code already belongs to a submitted report. Use it to track that report.");
      return { reference: prior.id, createdAt: prior.created_at };
    }
    const reference = `WB-${randomBytes(8).toString("hex").toUpperCase()}`;
    const at = now();
    db.prepare(`
      INSERT INTO reports (id, code_hash, submission_hash, category, summary, description, occurred_on, location, contact_email, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
    `).run(reference, codeHash, submissionHash, ...values, at, at);
    eventInsert.run(reference, null, "status", "system", "received", at);
    return { reference, createdAt: at };
  });
}

function lookupReport(code) {
  const normalized = normalizeCode(code);
  const report = normalized.length === 24 ? reportByCode.get(sha256(normalized)) : null;
  if (!report) throw new HttpError(404, "We couldn’t find a report with that case code. Check the code and try again.", "code");
  return report;
}

function caseSummary(report) {
  return {
    reference: report.id, category: report.category, summary: report.summary,
    status: report.status, createdAt: report.created_at, updatedAt: report.updated_at,
  };
}

function caseDetail(report, reviewer) {
  return {
    ...caseSummary(report),
    ...(reviewer ? {
      description: report.description, occurredOn: report.occurred_on,
      location: report.location, contactEmail: report.contact_email,
    } : {}),
    events: eventList.all(report.id),
  };
}

function addMessage(report, body, actor) {
  const value = checkedText(body, "message", 1, 2500, "a message");
  if (typeof body.clientId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.clientId)) {
    throw new HttpError(400, "This message could not be sent. Try again.");
  }
  return transaction(() => {
    const current = reportById.get(report.id);
    const prior = db.prepare("SELECT value FROM events WHERE report_id = ? AND actor = ? AND client_id = ?")
      .get(current.id, actor, body.clientId);
    if (prior) {
      if (prior.value !== value) throw new HttpError(409, "A different message has already been sent with this request.");
      return current;
    }
    if (current.status === "resolved") throw new HttpError(409, "This report is resolved. Messaging is closed.");
    const at = now();
    eventInsert.run(current.id, body.clientId, "message", actor, value, at);
    db.prepare("UPDATE reports SET updated_at = ? WHERE id = ?").run(at, current.id);
    return reportById.get(current.id);
  });
}

function updateStatus(report, status) {
  if (typeof status !== "string" || !hasStatus(status)) throw new HttpError(400, "Choose a valid status.");
  return transaction(() => {
    const current = reportById.get(report.id);
    if (current.status === status) return current;
    const at = now();
    db.prepare("UPDATE reports SET status = ?, updated_at = ? WHERE id = ?").run(status, at, current.id);
    eventInsert.run(current.id, null, "status", "reviewer", status, at);
    return reportById.get(current.id);
  });
}

function sessionHash(request) {
  const token = request.headers.cookie?.match(/(?:^|;\s*)wb_reviewer=([a-f0-9]{64})(?:;|$)/)?.[1];
  return token ? sha256(token) : "";
}

function requireReviewer(request) {
  const session = db.prepare("SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?").get(sessionHash(request), Date.now());
  if (!session) throw new HttpError(401, "Sign in to access the reviewer inbox.");
}

function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(data));
}

async function api(request, response, url) {
  const { pathname } = url;
  const post = request.method === "POST";
  if (post && (request.headers.origin !== url.origin || request.headers["sec-fetch-site"] === "cross-site")) {
    throw new HttpError(403, "Open the reporting portal directly and try again.");
  }
  if (post && pathname === "/api/reports") {
    limit(request, "submit", 15, 10 * 60_000);
    return sendJson(response, 201, newReport(await readBody(request)));
  }
  if (post && pathname === "/api/track") {
    limit(request, "track", 40, 5 * 60_000);
    const body = await readBody(request);
    return sendJson(response, 200, caseDetail(lookupReport(body.code), false));
  }
  if (post && pathname === "/api/track/message") {
    limit(request, "message", 40, 5 * 60_000);
    const body = await readBody(request);
    return sendJson(response, 200, caseDetail(addMessage(lookupReport(body.code), body, "reporter"), false));
  }
  if (post && pathname === "/api/reviewer/login") {
    limit(request, "login", 8, 5 * 60_000);
    if (!passwordHash) throw new HttpError(503, "Reviewer access needs a local passphrase. See the setup instructions.");
    const { password } = await readBody(request);
    if (typeof password !== "string" || password.length > 512 || !timingSafeEqual(await derivePassword(password, passwordSalt, 64), passwordHash)) {
      throw new HttpError(401, "That passphrase didn’t match. Try again.", "password");
    }
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)").run(sha256(token), Date.now() + sessionSeconds * 1000);
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sessionHash(request));
    return sendJson(response, 200, { signedIn: true }, {
      "Set-Cookie": `wb_reviewer=${token}; Path=/api/reviewer; HttpOnly; SameSite=Strict; Max-Age=${sessionSeconds}`,
    });
  }
  if (post && pathname === "/api/reviewer/logout") {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sessionHash(request));
    return sendJson(response, 200, { signedIn: false }, {
      "Set-Cookie": "wb_reviewer=; Path=/api/reviewer; HttpOnly; SameSite=Strict; Max-Age=0",
    });
  }
  if (request.method === "GET" && pathname === "/api/reviewer/reports") {
    requireReviewer(request);
    const filter = url.searchParams.get("status") ?? "";
    const rawPage = Number(url.searchParams.get("page") ?? 1);
    const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 1_000_000 ? rawPage : 1;
    if (filter && !hasStatus(filter)) throw new HttpError(400, "Choose a valid status.");
    const where = filter ? " WHERE status = ?" : "";
    const args = filter ? [filter] : [];
    const size = 20;
    const total = db.prepare(`SELECT COUNT(*) AS total FROM reports${where}`).get(...args).total;
    const reports = db.prepare(`SELECT * FROM reports${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, size, (page - 1) * size).map(caseSummary);
    return sendJson(response, 200, { reports, total, page, pages: Math.max(1, Math.ceil(total / size)) });
  }
  const match = pathname.match(/^\/api\/reviewer\/reports\/(WB-[0-9A-F]{16})(?:\/(status|message))?$/);
  if (match) {
    requireReviewer(request);
    const report = reportById.get(match[1]);
    if (!report) throw new HttpError(404, "This report could not be found.");
    if (request.method === "GET" && !match[2]) return sendJson(response, 200, caseDetail(report, true));
    if (post && match[2]) {
      const body = await readBody(request);
      const updated = match[2] === "status" ? updateStatus(report, body.status) : addMessage(report, body, "reviewer");
      return sendJson(response, 200, caseDetail(updated, true));
    }
  }
  throw new HttpError(404, "This page could not be found.");
}

const server = createServer(async (request, response) => {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Cache-Control", "no-store");
  try {
    const actualPort = server.address().port;
    const allowedHosts = [`${host}:${actualPort}`, `localhost:${actualPort}`];
    if (!allowedHosts.includes(request.headers.host)) throw new HttpError(403, "Open the local reporting portal directly.");
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.host !== request.headers.host) throw new HttpError(400, "Invalid request path.");
    if (url.pathname.startsWith("/api/")) return await api(request, response, url);
    const file = publicPaths.get(url.pathname);
    if (!file || !["GET", "HEAD"].includes(request.method)) throw new HttpError(404, "This page could not be found.");
    const path = join(root, "public", file[0]);
    try { accessSync(path); } catch { throw new HttpError(404, "This asset could not be found."); }
    const content = readFileSync(path);
    response.writeHead(200, { "Content-Type": file[1], "Content-Length": content.length });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) {
    if (response.headersSent || response.destroyed) return;
    if (!(error instanceof HttpError)) console.error("Request failed", error.code || error.name);
    sendJson(response, error.status || 500, { error: error.status ? error.message : "Something went wrong. Try again in a moment.", field: error.field });
  }
});

server.requestTimeout = 15_000;
server.listen(port, host, () => {
  console.log(`Whistleblower is running at http://${host}:${server.address().port}/`);
  if (demo) console.log(`Demo uses temporary data. Reviewer passphrase: ${configuredPassword}`);
  else if (!passwordHash) console.log("Reviewer access is disabled until WHISTLEBLOWER_REVIEWER_PASSWORD is set.");
});
