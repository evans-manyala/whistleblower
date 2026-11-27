import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { categories, statuses } from "../public/catalog.js";
import { caseHistoryWriter, transaction } from "./case-history.mjs";
import { checkedText, HttpError, limit, readBody, readCookie, sendJson } from "./http.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const derivePassword = promisify(scrypt);
const sessionSeconds = 12 * 60 * 60;

export function localReviewerAccess(db, configuredPassword) {
  if (configuredPassword !== null && (configuredPassword.length < 14 || configuredPassword.length > 512)) {
    throw new Error("WHISTLEBLOWER_REVIEWER_PASSWORD must be 14–512 characters.");
  }
  const salt = randomBytes(16);
  const passwordHash = configuredPassword === null ? null : scryptSync(configuredPassword, salt, 64);
  const sessionHash = (request) => sha256(readCookie(request, "wb_reviewer"));
  return {
    requireReviewer(request) {
      const session = db.prepare("SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?").get(sessionHash(request), Date.now());
      if (!session) throw new HttpError(401, "Sign in to access the reviewer inbox.");
    },
    async signIn(request, response) {
      if (!passwordHash) throw new HttpError(503, "Reviewer access needs a local passphrase. See the setup instructions.");
      const { password } = await readBody(request);
      if (typeof password !== "string" || password.length > 512 || !timingSafeEqual(await derivePassword(password, salt, 64), passwordHash)) {
        throw new HttpError(401, "That passphrase didn’t match. Try again.", "password");
      }
      const token = randomBytes(32).toString("hex");
      db.prepare("DELETE FROM sessions WHERE token_hash = ? OR expires_at <= ?").run(sessionHash(request), Date.now());
      db.prepare("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)").run(sha256(token), Date.now() + sessionSeconds * 1000);
      sendJson(response, 200, { signedIn: true }, {
        "Set-Cookie": `wb_reviewer=${token}; Path=/api/reviewer; HttpOnly; SameSite=Strict; Max-Age=${sessionSeconds}`,
      });
    },
    signOut(request, response) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sessionHash(request));
      sendJson(response, 200, { signedIn: false }, {
        "Set-Cookie": "wb_reviewer=; Path=/api/reviewer; HttpOnly; SameSite=Strict; Max-Age=0",
      });
    },
  };
}

export function createReportingApi(db, access) {
  const history = caseHistoryWriter(db);
  const now = () => new Date().toISOString();
  function normalizeCode(value) {
    if (typeof value !== "string") return "";
    if (access.caseNamespace) {
      const match = value.trim().match(/^WB\/([a-z0-9-]{1,40})\/([0-9A-F\s-]{24,60})$/i);
      if (match?.[1].toLowerCase() !== access.caseNamespace) return "";
      return match[2].replace(/[\s-]/g, "").toUpperCase();
    }
    return /^WB[\s-]*[0-9A-F\s-]{24,60}$/i.test(value.trim())
      ? value.trim().replace(/[\s-]/g, "").slice(2).toUpperCase() : "";
  }
  const hashCode = (code) => sha256(access.caseNamespace ? `${access.caseNamespace}\0${code}` : code);
  const hasStatus = (status) => Object.hasOwn(statuses, status);
  const eventInsert = db.prepare("INSERT INTO events (report_id, client_id, kind, actor, value, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const eventList = db.prepare("SELECT kind, actor, value, created_at AS createdAt FROM events WHERE report_id = ? ORDER BY id");
  const reportById = db.prepare("SELECT * FROM reports WHERE id = ?");
  const reportByCode = db.prepare("SELECT * FROM reports WHERE code_hash = ?");
  function recordCaseEvent(reference, clientId, kind, actor, value, at) {
    const event = eventInsert.run(reference, clientId, kind, actor, value, at);
    history.recordEvent(reference, event.lastInsertRowid);
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
    const codeHash = hashCode(code);
    const values = [body.category, summary, description, date || null, location || null, email || null];
    const submissionHash = sha256(JSON.stringify(values));
    return transaction(db, () => {
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
      history.recordSubmission(reference);
      recordCaseEvent(reference, null, "status", "system", "received", at);
      return { reference, createdAt: at };
    });
  }

  function lookupReport(code) {
    const normalized = normalizeCode(code);
    const report = normalized.length === 24 ? reportByCode.get(hashCode(normalized)) : null;
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
    return transaction(db, () => {
      const current = reportById.get(report.id);
      const prior = db.prepare("SELECT value FROM events WHERE report_id = ? AND actor = ? AND client_id = ?")
        .get(current.id, actor, body.clientId);
      if (prior) {
        if (prior.value !== value) throw new HttpError(409, "A different message has already been sent with this request.");
        return current;
      }
      if (current.status === "resolved") throw new HttpError(409, "This report is resolved. Messaging is closed.");
      const at = now();
      recordCaseEvent(current.id, body.clientId, "message", actor, value, at);
      db.prepare("UPDATE reports SET updated_at = ? WHERE id = ?").run(at, current.id);
      return reportById.get(current.id);
    });
  }

  function updateStatus(report, status) {
    if (typeof status !== "string" || !hasStatus(status)) throw new HttpError(400, "Choose a valid status.");
    return transaction(db, () => {
      const current = reportById.get(report.id);
      if (current.status === status) return current;
      const at = now();
      db.prepare("UPDATE reports SET status = ?, updated_at = ? WHERE id = ?").run(status, at, current.id);
      recordCaseEvent(current.id, null, "status", "reviewer", status, at);
      return reportById.get(current.id);
    });
  }

  return async function api(request, response, url, pathname = url.pathname) {
    const post = request.method === "POST";
    if (post && pathname === "/api/reports") {
      limit(request, "submit", 15, 10 * 60_000);
      const body = await readBody(request);
      access.requireIntake?.();
      return sendJson(response, 201, newReport(body));
    }
    if (post && pathname === "/api/track") {
      limit(request, "track", 40, 5 * 60_000);
      const body = await readBody(request);
      access.requireActive?.();
      return sendJson(response, 200, caseDetail(lookupReport(body.code), false));
    }
    if (post && pathname === "/api/track/message") {
      limit(request, "message", 40, 5 * 60_000);
      const body = await readBody(request);
      access.requireActive?.();
      return sendJson(response, 200, caseDetail(addMessage(lookupReport(body.code), body, "reporter"), false));
    }
    if (post && pathname === "/api/reviewer/login") {
      limit(request, "reviewer-login", 12, 5 * 60_000);
      return await access.signIn(request, response, url);
    }
    if (post && pathname === "/api/reviewer/logout") return access.signOut(request, response, url);
    if (request.method === "GET" && pathname === "/api/reviewer/reports") {
      access.requireReviewer(request);
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
      access.requireReviewer(request);
      const report = reportById.get(match[1]);
      if (!report) throw new HttpError(404, "This report could not be found.");
      if (request.method === "GET" && !match[2]) return sendJson(response, 200, caseDetail(report, true));
      if (post && match[2]) {
        const body = await readBody(request);
        access.requireReviewer(request);
        const updated = match[2] === "status" ? updateStatus(report, body.status) : addMessage(report, body, "reviewer");
        return sendJson(response, 200, caseDetail(updated, true));
      }
    }
    throw new HttpError(404, "This page could not be found.");
  };
}
