import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { adminApi, tenantAccess } from "./lib/admin-api.mjs";
import { initializeDatabase } from "./lib/case-history.mjs";
import { HttpError, requireSameOrigin, sendJson } from "./lib/http.mjs";
import { createReportingApi, localReviewerAccess } from "./lib/reporting.mjs";
import { createPlatformStore, findOrganisation, openRegistry, openTenantDatabase } from "./lib/tenants.mjs";

process.umask(0o077);
const root = fileURLToPath(new URL(".", import.meta.url));
const dataDirectory = resolve(process.env.WHISTLEBLOWER_DATA_DIR || join(root, ".data"));
const demo = process.argv.includes("--demo");
const saas = !demo && (process.argv.includes("--saas") || process.env.WHISTLEBLOWER_MODE === "saas");
const host = "127.0.0.1";
const port = Number(process.env.PORT || 4310);
const publicOrigin = process.env.WHISTLEBLOWER_ORIGIN ? new URL(process.env.WHISTLEBLOWER_ORIGIN) : null;
if (publicOrigin && (!saas || publicOrigin.protocol !== "https:" || publicOrigin.href !== publicOrigin.origin + "/")) {
  throw new Error("WHISTLEBLOWER_ORIGIN must be an HTTPS origin in SaaS mode.");
}

let platformStore;
let registry;
let localApi;
let configuredPassword;
if (saas) {
  registry = openRegistry(dataDirectory);
  platformStore = createPlatformStore(registry, dataDirectory);
} else {
  configuredPassword = demo ? randomBytes(18).toString("base64url") : process.env.WHISTLEBLOWER_REVIEWER_PASSWORD ?? null;
  if (!demo) mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(demo ? ":memory:" : join(dataDirectory, "whistleblower.sqlite"));
  initializeDatabase(db);
  localApi = createReportingApi(db, localReviewerAccess(db, configuredPassword));
}

const web = new Map([
  ["/app.js", "text/javascript; charset=utf-8"],
  ["/admin.js", "text/javascript; charset=utf-8"],
  ["/catalog.js", "text/javascript; charset=utf-8"],
  ["/styles.css", "text/css; charset=utf-8"],
  ["/admin.css", "text/css; charset=utf-8"],
  ["/assets/hero.webp", "image/webp"],
  ["/assets/portal-icons.png", "image/png"],
  ["/assets/portal-icons-white.png", "image/png"],
  ["/assets/favicon.png", "image/png"],
]);
const escapeAttribute = (value) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

function page(request, response, file, type, organisation) {
  if (!["GET", "HEAD"].includes(request.method)) throw new HttpError(404, "This page could not be found.");
  let content = readFileSync(join(root, "public", file));
  if (organisation) {
    content = Buffer.from(content.toString().replace('name="whistleblower-organisation" content=""',
      () => `name="whistleblower-organisation" content="${escapeAttribute(organisation.name)}"`));
  }
  response.writeHead(200, { "Content-Type": type, "Content-Length": content.length });
  response.end(request.method === "HEAD" ? undefined : content);
}

function renderHtml(request, response, html, organisation) {
  return page(request, response, html, "text/html; charset=utf-8", organisation);
}

function redirect(response, location) {
  response.writeHead(308, { Location: location });
  response.end();
}

async function dispatch(request, response, url) {
  const path = url.pathname;
  if (web.has(path)) return page(request, response, path, web.get(path));
  if (!saas) {
    if (path === "/") return renderHtml(request, response, "index.html");
    if (path.startsWith("/api/")) return await localApi(request, response, url);
    throw new HttpError(404, "This page could not be found.");
  }

  if (path === "/" || path === "/platform/") return renderHtml(request, response, "admin.html");
  if (path === "/platform" && request.method === "GET") return redirect(response, "/platform/");
  if (path.startsWith("/platform/api/admin/")) return await adminApi(platformStore, request, response, url, "/platform", path.slice(9), null, { registry, dataDirectory });

  const match = path.match(/^\/o\/([a-z0-9-]+)(\/.*)?$/);
  const organisation = match ? findOrganisation(registry, match[1]) : null;
  if (!organisation?.active) throw new HttpError(404, "This organisation is unavailable.");
  const prefix = `/o/${organisation.slug}`;
  const relative = match[2];
  if ((!relative || relative === "/admin" || relative === "/join") && request.method === "GET") {
    return redirect(response, path + "/");
  }
  if (relative === "/") return renderHtml(request, response, "index.html", organisation);
  if (relative === "/admin/" || relative === "/join/") return renderHtml(request, response, "admin.html", organisation);
  if (relative?.startsWith("/api/admin/") || relative === "/api/auth/accept") {
    return await adminApi(platformStore, request, response, url, prefix, relative, organisation, { registry, dataDirectory });
  }
  if (relative?.startsWith("/api/")) {
    const db = openTenantDatabase(dataDirectory, organisation);
    try {
      return await createReportingApi(db, tenantAccess(platformStore, organisation))(request, response, url, relative);
    } finally { db.close(); }
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
    const allowedHosts = publicOrigin ? [publicOrigin.host] : [`${host}:${actualPort}`, `localhost:${actualPort}`];
    if (!allowedHosts.includes(request.headers.host)) throw new HttpError(403, "Open the reporting portal directly.");
    const base = publicOrigin?.origin ?? `http://${request.headers.host}`;
    const url = new URL(request.url, base);
    if (url.origin !== base) throw new HttpError(400, "Invalid request path.");
    const forwarded = request.headers["x-real-ip"];
    request.clientAddress = publicOrigin && typeof forwarded === "string" && isIP(forwarded) ? forwarded : request.socket.remoteAddress;
    requireSameOrigin(request, url);
    await dispatch(request, response, url);
  } catch (error) {
    if (response.headersSent || response.destroyed) return;
    if (!(error instanceof HttpError)) console.error("Request failed", error.code || error.name);
    sendJson(response, error.status || 500, { error: error.status ? error.message : "Something went wrong. Try again in a moment.", field: error.field });
  }
});

server.requestTimeout = 15_000;
server.listen(port, host, () => {
  if (saas) {
    function startWorker(name) {
      const worker = new Worker(new URL(`./scripts/${name}-worker.mjs`, import.meta.url), { workerData: { root: dataDirectory } });
      worker.on("error", error => console.error(`${name} worker failed`, error.code || error.name));
      worker.on("exit", () => { if (server.listening) setTimeout(() => startWorker(name), 60_000).unref(); });
      worker.unref();
    }
    startWorker("anchor");
    if (process.env.WHISTLEBLOWER_KEYS_DIR && process.env.WHISTLEBLOWER_ARCHIVE_DIR) startWorker("backup");
  }
  console.log(`Whistleblower is running at http://${host}:${server.address().port}/${saas ? " (SaaS)" : ""}`);
  if (demo) console.log(`Demo uses temporary data. Reviewer passphrase: ${configuredPassword}`);
  else if (!saas && !configuredPassword) console.log("Reviewer access is disabled until WHISTLEBLOWER_REVIEWER_PASSWORD is set.");
});
