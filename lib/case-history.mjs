import { createHash, randomBytes } from "node:crypto";
import { statuses } from "../public/catalog.js";

const schemaVersion = 1;
const hashPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[0-9a-f]{32}$/;
const checkpointFormat = "whistleblower-case-history-v1";
const genesis = "0".repeat(64);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const baseline = `
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
`;

const historySchema = `
  CREATE TABLE integrity_log (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL
  );
  CREATE TABLE case_history (
    sequence INTEGER PRIMARY KEY CHECK(sequence > 0),
    report_id TEXT NOT NULL REFERENCES reports(id),
    event_id INTEGER UNIQUE REFERENCES events(id),
    nonce TEXT NOT NULL, previous_hash TEXT NOT NULL, entry_hash TEXT NOT NULL
  );
  CREATE UNIQUE INDEX case_history_submissions ON case_history(report_id) WHERE event_id IS NULL;
  CREATE TRIGGER case_history_no_update BEFORE UPDATE ON case_history
    BEGIN SELECT RAISE(ABORT, 'Case history is append-only'); END;
  CREATE TRIGGER case_history_no_delete BEFORE DELETE ON case_history
    BEGIN SELECT RAISE(ABORT, 'Case history is append-only'); END;
  CREATE TRIGGER case_events_no_update BEFORE UPDATE ON events
    BEGIN SELECT RAISE(ABORT, 'Case events are append-only'); END;
  CREATE TRIGGER case_events_no_delete BEFORE DELETE ON events
    BEGIN SELECT RAISE(ABORT, 'Case events are append-only'); END;
`;

export function transaction(db, run, mode = "IMMEDIATE") {
  db.exec(`BEGIN ${mode}`);
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function logId(db) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version !== schemaVersion) throw new Error("Unsupported case history schema. Start the updated app to migrate a v0 database.");
  const id = db.prepare("SELECT id FROM integrity_log WHERE singleton = 1").get()?.id;
  if (!idPattern.test(id ?? "")) throw new Error("Case history log ID is missing or invalid.");
  return id;
}

export function initializeDatabase(db) {
  db.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  transaction(db, () => {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version === 0) {
      db.exec(baseline);
      db.exec(historySchema);
      db.prepare("INSERT INTO integrity_log (singleton, id) VALUES (1, ?)").run(randomBytes(16).toString("hex"));
      db.exec(`PRAGMA user_version = ${schemaVersion}`);
      const history = caseHistoryWriter(db);
      for (const report of db.prepare("SELECT id FROM reports ORDER BY created_at, id").iterate()) {
        history.recordSubmission(report.id);
      }
      for (const event of db.prepare("SELECT id, report_id FROM events ORDER BY id").iterate()) {
        history.recordEvent(event.report_id, event.id);
      }
      verifySnapshot(db);
    }
    logId(db);
    db.exec("DELETE FROM sessions;");
  });
}

function sources(db) {
  return {
    report: db.prepare("SELECT * FROM reports WHERE id = ?"),
    event: db.prepare("SELECT * FROM events WHERE id = ?"),
  };
}

function reportPayload(report) {
  return [
    report.id, report.code_hash, report.submission_hash, report.category, report.summary,
    report.description, report.occurred_on, report.location, report.contact_email, report.created_at,
  ];
}

function eventPayload(event) {
  return [event.id, event.report_id, event.client_id, event.kind, event.actor, event.value, event.created_at];
}

function entryHash(id, sequence, previous, nonce, type, payload) {
  return sha256(JSON.stringify([checkpointFormat, id, sequence, previous, nonce, type, payload]));
}

// Call writers inside the same SQLite write transaction as the case record.
export function caseHistoryWriter(db) {
  const id = logId(db);
  const read = sources(db);
  const head = db.prepare("SELECT sequence, entry_hash FROM case_history ORDER BY sequence DESC LIMIT 1");
  const insert = db.prepare(`
    INSERT INTO case_history (sequence, report_id, event_id, nonce, previous_hash, entry_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  function append(reportId, eventId, type, payload) {
    const last = head.get();
    const sequence = (last?.sequence ?? 0) + 1;
    const previous = last?.entry_hash ?? genesis;
    const nonce = randomBytes(32).toString("hex");
    insert.run(sequence, reportId, eventId, nonce, previous, entryHash(id, sequence, previous, nonce, type, payload));
  }
  return {
    recordSubmission(reportId) {
      const report = read.report.get(reportId);
      if (!report) throw new Error("Cannot record an absent report.");
      append(reportId, null, "submission", reportPayload(report));
    },
    recordEvent(reportId, eventId) {
      const event = read.event.get(eventId);
      if (event?.report_id !== reportId) throw new Error("Cannot record an event for the wrong report.");
      append(reportId, eventId, "event", eventPayload(event));
    },
  };
}

function merkleAccumulator() {
  const levels = [];
  const combine = (prefix, ...values) => createHash("sha256").update(Buffer.from([prefix]))
    .update(Buffer.concat(values)).digest();
  return {
    add(hash) {
      let node = combine(0, Buffer.from(hash, "hex"));
      let level = 0;
      while (levels[level]) {
        node = combine(1, levels[level], node);
        levels[level] = null;
        level += 1;
      }
      levels[level] = node;
    },
    root() {
      let tree;
      for (const node of levels) if (node) tree = tree ? combine(1, node, tree) : node;
      return tree?.toString("hex") ?? sha256("");
    },
  };
}

export function validateCheckpoint(value) {
  if (!value || Object.keys(value).length !== 4 || value.format !== checkpointFormat
      || typeof value.logId !== "string" || !idPattern.test(value.logId)
      || !Number.isSafeInteger(value.entries) || value.entries < 1
      || typeof value.root !== "string" || !hashPattern.test(value.root)) {
    throw new Error("Invalid case history checkpoint.");
  }
  return value;
}

function verifySnapshot(db, checkpoint, expectedLogId) {
  const id = logId(db);
  if (expectedLogId && id !== expectedLogId) throw new Error("Case data belongs to a different organisation.");
  if (checkpoint && checkpoint.logId !== id) throw new Error("Checkpoint belongs to a different case history.");
  const read = sources(db);
  const projections = new Map();
  const eventIds = new Set();
  const merkle = merkleAccumulator();
  let count = 0;
  let previous = genesis;
  for (const row of db.prepare("SELECT * FROM case_history ORDER BY sequence").iterate()) {
    count += 1;
    const fail = (reason) => { throw new Error(`Case history integrity failure at entry ${count}. ${reason}`); };
    if (row.sequence !== count || row.previous_hash !== previous || !hashPattern.test(row.nonce)) {
      fail("Sequence, hash link or nonce mismatch.");
    }
    let expected;
    if (row.event_id === null) {
      const report = read.report.get(row.report_id);
      if (!report || projections.has(row.report_id)) fail("Submission is missing or duplicated.");
      expected = entryHash(id, count, previous, row.nonce, "submission", reportPayload(report));
      projections.set(row.report_id, { report, status: null, updatedAt: null });
    } else {
      const event = read.event.get(row.event_id);
      const state = projections.get(row.report_id);
      if (!event || event.report_id !== row.report_id || !state || eventIds.has(row.event_id)) {
        fail("Event is missing, duplicated or assigned to the wrong case.");
      }
      if (!state.status && (event.kind !== "status" || event.actor !== "system" || event.value !== "received" || event.created_at !== state.report.created_at)) {
        fail("The first event must record receipt of the report.");
      }
      if (event.kind === "status") {
        if (!Object.hasOwn(statuses, event.value) || (state.status && event.actor !== "reviewer")) fail("Invalid status event.");
        state.status = event.value;
      } else if (event.kind !== "message" || !["reporter", "reviewer"].includes(event.actor) || state.status === "resolved") {
        fail("Invalid case message.");
      }
      state.updatedAt = event.created_at;
      eventIds.add(row.event_id);
      expected = entryHash(id, count, previous, row.nonce, "event", eventPayload(event));
    }
    if (row.entry_hash !== expected) fail("Report or event contents do not match their recorded hash.");
    previous = expected;
    merkle.add(expected);
    if (checkpoint?.entries === count && checkpoint.root !== merkle.root()) {
      fail("The case history root does not match the retained checkpoint.");
    }
  }
  if (checkpoint && count < checkpoint.entries) throw new Error("Case history is shorter than the retained checkpoint.");
  const totals = db.prepare("SELECT (SELECT COUNT(*) FROM reports) AS reports, (SELECT COUNT(*) FROM events) AS events").get();
  if (projections.size !== totals.reports || eventIds.size !== totals.events) {
    throw new Error("Case history integrity failure. A report or event is missing from the log.");
  }
  for (const state of projections.values()) {
    if (!state.status || state.report.status !== state.status || state.report.updated_at !== state.updatedAt) {
      throw new Error("Case history integrity failure. A report status or update time differs from its case events.");
    }
  }
  return { format: checkpointFormat, logId: id, entries: count, root: merkle.root() };
}

export function verifyCaseHistory(db, checkpoint, expectedLogId) {
  if (checkpoint) validateCheckpoint(checkpoint);
  return transaction(db, () => verifySnapshot(db, checkpoint, expectedLogId), "DEFERRED");
}
