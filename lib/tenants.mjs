import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { initializeDatabase, transaction } from "./case-history.mjs";
import { HttpError } from "./http.mjs";

export const platform = "platform";
export const roles = { platform: "platform_admin", organisation: "organisation_admin", reviewer: "reviewer" };
export const slugPattern = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const idPattern = /^[0-9a-f]{32}$/;
const tokenPattern = /^[0-9a-f]{64}$/;
const sessionLifetime = 8 * 60 * 60 * 1000;
const invitationLifetime = 72 * 60 * 60 * 1000;
const derive = promisify(scrypt);
const dummySalt = randomBytes(16);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const randomId = () => randomBytes(16).toString("hex");
const randomToken = () => randomBytes(32).toString("hex");

const schema = `
  CREATE TABLE IF NOT EXISTS organisations (
    id TEXT PRIMARY KEY, log_id TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    intake_open INTEGER NOT NULL DEFAULT 1 CHECK(intake_open IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS anchor_scans (
    org TEXT PRIMARY KEY REFERENCES organisations(id), next_at INTEGER NOT NULL DEFAULT 0,
    checked_at INTEGER, failed INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS anchor_jobs (
    org TEXT NOT NULL REFERENCES organisations(id), entries INTEGER NOT NULL CHECK(entries > 0),
    manifest TEXT NOT NULL, created_at INTEGER NOT NULL, next_at INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('queued','pending','verifying','verified')),
    failed INTEGER NOT NULL DEFAULT 0, block INTEGER, verified_at INTEGER, receipt_hash TEXT,
    PRIMARY KEY(org, entries)
  );
  CREATE INDEX IF NOT EXISTS anchor_due ON anchor_jobs(org, next_at) WHERE phase != 'verified';
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL,
    salt BLOB NOT NULL, password_hash BLOB NOT NULL, UNIQUE(scope, email),
    CHECK((scope = 'platform' AND role = 'platform_admin') OR
          (scope != 'platform' AND role IN ('organisation_admin','reviewer')))
  );
  CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL,
    email TEXT NOT NULL, role TEXT NOT NULL, expires_at INTEGER NOT NULL,
    UNIQUE(scope,email), CHECK(scope != 'platform' AND role IN ('organisation_admin','reviewer'))
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
`;

function normalEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "Enter a valid email address.", "email");
  }
  return email;
}

function normalName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 2 || name.length > 100) throw new HttpError(400, "Enter a name using 2–100 characters.", "name");
  return name;
}

async function passwordRecord(password) {
  if (typeof password !== "string" || password.length < 14 || password.length > 512) {
    throw new HttpError(400, "Use a passphrase of 14–512 characters.", "password");
  }
  const salt = randomBytes(16);
  return [salt, await derive(password, salt, 64)];
}

export function registryPath(root) {
  return join(root, "platform.sqlite");
}

export function organisationDirectory(parent, organisation) {
  if (!idPattern.test(organisation.id)) throw new Error("Invalid organisation storage ID.");
  return join(parent, organisation.id);
}

export function tenantDirectory(root, organisation) {
  return organisationDirectory(join(root, "organisations"), organisation);
}

export function tenantDatabasePath(root, organisation) {
  return join(tenantDirectory(root, organisation), "whistleblower.sqlite");
}

export function requireCaseLog(db, expectedLogId) {
  const row = db.prepare("SELECT id FROM integrity_log WHERE singleton = 1").get();
  if (!row || row.id !== expectedLogId) throw new Error("Case data belongs to a different organisation.");
}

export function openTenantDatabase(root, organisation) {
  const path = tenantDatabasePath(root, organisation);
  if (!statSync(path).isFile()) throw new Error("Organisation case database is unavailable.");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON; PRAGMA busy_timeout = 5000;");
    requireCaseLog(db, organisation.log_id);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openRegistry(root, { readOnly = false } = {}) {
  if (!readOnly) mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(registryPath(root), { readOnly });
  if (!readOnly) {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    db.exec(schema);
  }
  return db;
}

export function findOrganisation(db, slug) {
  if (typeof slug !== "string" || !slugPattern.test(slug)) return null;
  return db.prepare("SELECT * FROM organisations WHERE slug = ?").get(slug);
}

export function publicOrganisation(row) {
  return { slug: row.slug, name: row.name, active: Boolean(row.active), intakeOpen: Boolean(row.intake_open) };
}

export function createPlatformStore(db, root) {
  const byOrgId = db.prepare("SELECT * FROM organisations WHERE id = ?");
  const byEmail = db.prepare("SELECT * FROM accounts WHERE scope = ? AND email = ?");
  const insertAccount = db.prepare("INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?)");
  const pending = db.prepare("SELECT * FROM invites WHERE scope = ? AND token_hash = ? AND expires_at > ?");
  const insertSession = db.prepare("INSERT INTO auth_sessions VALUES (?, ?, ?)");

  function activeOrg(scope) {
    const organisation = byOrgId.get(scope);
    if (!organisation?.active) throw new HttpError(404, "This organisation is unavailable.");
    return organisation;
  }

  function issueInvite(scope, email, role) {
    if (![roles.organisation, roles.reviewer].includes(role)) throw new HttpError(400, "Choose an organisation role.", "role");
    if (byEmail.get(scope, email)) throw new HttpError(409, "That email already has access to this organisation.", "email");
    const code = randomToken();
    const expiresAt = Date.now() + invitationLifetime;
    db.prepare(`INSERT INTO invites VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope,email) DO UPDATE SET id=excluded.id, token_hash=excluded.token_hash,
        role=excluded.role, expires_at=excluded.expires_at`)
      .run(randomId(), digest(code), scope, email, role, expiresAt);
    return { email, role, code, expiresAt };
  }

  function createSession(accountId, oldToken, scope) {
    db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(Date.now());
    if (oldToken) revokeSession(oldToken, scope);
    const token = randomToken();
    insertSession.run(digest(token), accountId, Date.now() + sessionLifetime);
    return token;
  }

  function revokeSession(token, scope) {
    if (!tokenPattern.test(token)) return;
    db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?
      AND account_id IN (SELECT id FROM accounts WHERE scope = ?)`).run(digest(token), scope);
  }

  return {
    activeOrg,
    revokeSession,
    async createPlatformAdmin(email, password) {
      email = normalEmail(email);
      const [salt, hash] = await passwordRecord(password);
      transaction(db, () => {
        if (byEmail.get(platform, email)) throw new HttpError(409, "That platform administrator already exists.");
        insertAccount.run(randomId(), platform, email, roles.platform, salt, hash);
      });
    },
    async signIn(scope, allowedRole, body, oldToken) {
      const email = normalEmail(body.email);
      const password = body.password;
      if (typeof password !== "string" || password.length > 512) throw new HttpError(401, "Email or passphrase didn’t match.");
      const account = byEmail.get(scope, email);
      const candidate = await derive(password, account?.salt ?? dummySalt, 64);
      if (!account || !timingSafeEqual(candidate, account.password_hash) || account.role !== allowedRole) {
        throw new HttpError(401, "Email or passphrase didn’t match.");
      }
      return transaction(db, () => {
        if (scope !== platform) activeOrg(scope);
        // A revocation may have completed while scrypt was running.
        if (byEmail.get(scope, email)?.id !== account.id) throw new HttpError(401, "Email or passphrase didn’t match.");
        return { token: createSession(account.id, oldToken, scope), role: account.role };
      });
    },
    session(scope, requestToken, role) {
      if (!tokenPattern.test(requestToken)) return null;
      if (scope !== platform) activeOrg(scope);
      const account = db.prepare(`SELECT a.id, a.email, a.role FROM auth_sessions s
        JOIN accounts a ON a.id = s.account_id
        WHERE a.scope = ? AND s.token_hash = ? AND s.expires_at > ?`).get(scope, digest(requestToken), Date.now());
      return account?.role === role ? account : null;
    },
    async accept(scope, body, oldToken) {
      const code = typeof body.code === "string" ? body.code.trim() : "";
      const invalid = () => new HttpError(400, "This invitation is invalid, expired, or has already been used.", "code");
      if (!tokenPattern.test(code) || !pending.get(scope, digest(code), Date.now())) throw invalid();
      const [salt, hash] = await passwordRecord(body.password);
      return transaction(db, () => {
        activeOrg(scope);
        const invite = pending.get(scope, digest(code), Date.now());
        if (!invite || byEmail.get(scope, invite.email)) throw invalid();
        const accountId = randomId();
        insertAccount.run(accountId, scope, invite.email, invite.role, salt, hash);
        db.prepare("DELETE FROM invites WHERE id = ?").run(invite.id);
        return { token: createSession(accountId, oldToken, scope), role: invite.role };
      });
    },
    provision(body) {
      const name = normalName(body.name);
      const slug = body.slug;
      if (typeof slug !== "string" || !slugPattern.test(slug)) {
        throw new HttpError(400, "Use 1–40 lowercase letters, numbers, or hyphens for the portal address.", "slug");
      }
      const email = normalEmail(body.adminEmail);
      const id = randomId();
      const directory = tenantDirectory(root, { id });
      let created = false;
      try {
        return transaction(db, () => {
          if (findOrganisation(db, slug)) throw new HttpError(409, "That portal address is already in use.", "slug");
          mkdirSync(join(root, "organisations"), { recursive: true, mode: 0o700 });
          mkdirSync(directory, { mode: 0o700 });
          created = true;
          const cases = new DatabaseSync(tenantDatabasePath(root, { id }));
          let logId;
          try {
            initializeDatabase(cases);
            logId = cases.prepare("SELECT id FROM integrity_log WHERE singleton = 1").get().id;
          } finally { cases.close(); }
          db.prepare("INSERT INTO organisations (id, log_id, slug, name) VALUES (?, ?, ?, ?)").run(id, logId, slug, name);
          const invite = issueInvite(id, email, roles.organisation);
          return { organisation: publicOrganisation(byOrgId.get(id)), invite };
        });
      } catch (error) {
        if (created) rmSync(directory, { recursive: true, force: true });
        throw error;
      }
    },
    organisations() {
      return db.prepare(`SELECT o.*, EXISTS (SELECT 1 FROM accounts a WHERE a.scope = o.id
        AND a.role = 'organisation_admin') AS has_admin FROM organisations o ORDER BY name COLLATE NOCASE, slug`).all()
        .map((o) => ({ ...publicOrganisation(o), hasAdministrator: Boolean(o.has_admin) }));
    },
    reissueSetupInvite(slug, email) {
      email = normalEmail(email);
      const organisation = findOrganisation(db, slug);
      if (!organisation?.active) throw new HttpError(404, "This organisation is unavailable.");
      return transaction(db, () => {
        if (db.prepare("SELECT 1 FROM accounts WHERE scope = ? AND role = ?").get(organisation.id, roles.organisation)) {
          throw new HttpError(409, "This organisation already has an administrator.");
        }
        db.prepare("DELETE FROM invites WHERE scope = ? AND role = ?").run(organisation.id, roles.organisation);
        return { organisation: publicOrganisation(organisation), invite: issueInvite(organisation.id, email, roles.organisation) };
      });
    },
    setOrganisationActive(slug, active) {
      if (typeof active !== "boolean") throw new HttpError(400, "Choose the organisation’s access state.");
      const organisation = findOrganisation(db, slug);
      if (!organisation) throw new HttpError(404, "Organisation unavailable.");
      return transaction(db, () => {
        db.prepare("UPDATE organisations SET active = ? WHERE id = ?").run(Number(active), organisation.id);
        if (!active) db.prepare(`DELETE FROM auth_sessions
          WHERE account_id IN (SELECT id FROM accounts WHERE scope = ?)`).run(organisation.id);
        return publicOrganisation(byOrgId.get(organisation.id));
      });
    },
    organisationAccess(scope) {
      return {
        organisation: publicOrganisation(activeOrg(scope)),
        accounts: db.prepare("SELECT id, email, role FROM accounts WHERE scope = ? ORDER BY role, email").all(scope),
        invites: db.prepare("SELECT id, email, role, expires_at AS expiresAt FROM invites WHERE scope = ? AND expires_at > ? ORDER BY email").all(scope, Date.now()),
      };
    },
    updateOrganisation(scope, body) {
      const name = normalName(body.name);
      if (typeof body.intakeOpen !== "boolean") throw new HttpError(400, "Choose whether the portal accepts new reports.", "intakeOpen");
      activeOrg(scope);
      db.prepare("UPDATE organisations SET name = ?, intake_open = ? WHERE id = ?").run(name, Number(body.intakeOpen), scope);
      return publicOrganisation(byOrgId.get(scope));
    },
    invite(scope, body) {
      const email = normalEmail(body.email);
      return transaction(db, () => {
        activeOrg(scope);
        return issueInvite(scope, email, body.role);
      });
    },
    revokeInvite(scope, id) {
      return db.prepare("DELETE FROM invites WHERE id = ? AND scope = ?").run(id, scope).changes === 1;
    },
    revokeMember(scope, actorId, targetId) {
      if (actorId === targetId) throw new HttpError(409, "Ask another organisation administrator to remove your access.");
      return db.prepare("DELETE FROM accounts WHERE id = ? AND scope = ?").run(targetId, scope).changes === 1;
    },
  };
}
