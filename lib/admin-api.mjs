import { backupHealth } from "./scheduled-backups.mjs";
import { anchorStatus, verifiedArtifact } from "./anchors.mjs";
import { HttpError, limit, readBody, readCookie, sendJson } from "./http.mjs";
import { platform, roles, publicOrganisation } from "./tenants.mjs";

const cookieName = "wb_account";
const sessionSeconds = 8 * 60 * 60;

function cookie(token, prefix, url, seconds) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${cookieName}=${token}; Path=${prefix}/api; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure}`;
}

function account(store, request, scope, role) {
  const user = store.session(scope, readCookie(request, cookieName), role);
  if (!user) throw new HttpError(401, "Sign in to continue.");
  return user;
}

async function signIn(store, request, response, url, prefix, scope, role) {
  const result = await store.signIn(scope, role, await readBody(request), readCookie(request, cookieName));
  return sendJson(response, 200, { role: result.role }, { "Set-Cookie": cookie(result.token, prefix, url, sessionSeconds) });
}

function signOut(store, request, response, url, prefix, scope) {
  store.revokeSession(readCookie(request, cookieName), scope);
  return sendJson(response, 200, { signedIn: false }, { "Set-Cookie": cookie("", prefix, url, 0) });
}

export function tenantAccess(store, organisation) {
  const scope = organisation.id;
  const prefix = `/o/${organisation.slug}`;
  return {
    caseNamespace: organisation.slug,
    signIn: (request, response, url) => signIn(store, request, response, url, prefix, scope, roles.reviewer),
    signOut: (request, response, url) => signOut(store, request, response, url, prefix, scope),
    requireReviewer: (request) => account(store, request, scope, roles.reviewer),
    requireActive: () => store.activeOrg(scope),
    requireIntake() {
      if (!store.activeOrg(scope).intake_open) throw new HttpError(403, "This organisation has paused new reports.");
    },
  };
}

export async function adminApi(store, request, response, url, prefix, path, organisation, storage) {
  const scope = organisation?.id ?? platform;
  const role = organisation ? roles.organisation : roles.platform;
  const post = request.method === "POST";
  const get = request.method === "GET";
  if (post && path === "/api/admin/login") {
    limit(request, "admin-login", 12, 5 * 60_000);
    return await signIn(store, request, response, url, prefix, scope, role);
  }
  if (post && path === "/api/admin/logout") return signOut(store, request, response, url, prefix, scope);
  if (post && path === "/api/auth/accept" && organisation) {
    limit(request, "accept-invite", 15, 5 * 60_000);
    const result = await store.accept(scope, await readBody(request), readCookie(request, cookieName));
    return sendJson(response, 201, { role: result.role }, { "Set-Cookie": cookie(result.token, prefix, url, sessionSeconds) });
  }

  const user = account(store, request, scope, role);
  if (!organisation) {
    if (get && path === "/api/admin/backups") return sendJson(response, 200, backupHealth(storage.registry));
    if (get && path === "/api/admin/workspaces") {
      return sendJson(response, 200, { user, organisations: store.organisations(), backups: backupHealth(storage.registry) });
    }
    if (post && path === "/api/admin/workspaces") {
      const body = await readBody(request);
      account(store, request, scope, role);
      return sendJson(response, 201, store.provision(body));
    }
    const workspace = path.match(/^\/api\/admin\/workspaces\/([a-z0-9-]+)\/(access|setup-invite)$/);
    if (post && workspace) {
      const body = await readBody(request);
      account(store, request, scope, role);
      return sendJson(response, 200, workspace[2] === "access"
        ? store.setOrganisationActive(workspace[1], body.active)
        : store.reissueSetupInvite(workspace[1], body.email));
    }
  } else {
    if (get && path === "/api/admin/anchoring") return sendJson(response, 200, anchorStatus(storage.registry, organisation));
    if (get && path === "/api/admin/settings") return sendJson(response, 200, {
      user, ...store.organisationAccess(scope), anchoring: anchorStatus(storage.registry, organisation),
    });
    const artifact = path.match(/^\/api\/admin\/anchoring\/([1-9][0-9]{0,14})\/(checkpoint|receipt)$/);
    if (get && artifact) {
      const { name, bytes } = await verifiedArtifact(storage.registry, storage.dataDirectory, organisation, Number(artifact[1]), artifact[2] === "receipt");
      account(store, request, scope, role);
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length,
        "Content-Disposition": `attachment; filename="${name}"` });
      return response.end(bytes);
    }
    if (post && ["/api/admin/settings", "/api/admin/invites"].includes(path)) {
      const body = await readBody(request);
      account(store, request, scope, role);
      if (path.endsWith("/settings")) return sendJson(response, 200, { organisation: store.updateOrganisation(scope, body) });
      return sendJson(response, 201, { invite: store.invite(scope, body) });
    }
    const revoke = path.match(/^\/api\/admin\/(members|invites)\/([a-f0-9]{32})\/revoke$/);
    if (post && revoke) {
      const removed = revoke[1] === "members" ? store.revokeMember(scope, user.id, revoke[2]) : store.revokeInvite(scope, revoke[2]);
      if (!removed) throw new HttpError(404, "That access record could not be found.");
      return sendJson(response, 200, { removed });
    }
  }
  throw new HttpError(404, "This page could not be found.");
}
