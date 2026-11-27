const app = document.querySelector("#app");
const dialog = document.querySelector("#confirm-dialog");
const announce = document.querySelector("#admin-announcement");
const path = location.pathname;
const landing = path === "/";
const platform = path === "/platform/";
const joining = path.endsWith("/join/");
const tenantPrefix = path.match(/^\/o\/[a-z0-9-]+(?=\/)/)?.[0] ?? "";
const scope = platform ? "/platform" : tenantPrefix;
const tenantName = document.querySelector('meta[name="whistleblower-organisation"]').content;
const names = { platform_admin: "Platform Admin", organisation_admin: "Organisation Admin", reviewer: "Reviewer" };

let state = landing || joining ? "guest" : "loading";
let dashboard;
let invitation;
let showNew = false;
let filter = "";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);
const prefix = (slug) => `/o/${slug}`;
const date = (at) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(at));
const icon = (name, white = false) => `<span class="icon icon--${name}${white ? " icon--white" : ""}" aria-hidden="true"></span>`;
const intro = (title, text) => `<div class="page-intro"><h1 tabindex="-1">${title}</h1><p>${text}</p></div>`;
const heading = (title, text = "") => `<div class="panel-heading"><h2>${title}</h2>${text ? `<p>${text}</p>` : ""}</div>`;
const errorLine = '<p class="form-error" role="alert" hidden></p>';
const primary = (label, action = "submit") => `<button class="button button--primary press" type="${action}">${label}</button>`;
const rolePill = (label, active = true) => `<span class="status status--${active ? "resolved" : "reviewing"}"><span aria-hidden="true"></span>${label}</span>`;

function shell(content) {
  if (landing) return `<main class="main admin-portal" id="main" tabindex="-1">${content}</main>`;
  const home = platform ? "/" : tenantPrefix + "/";
  const title = platform ? "Platform administration" : dashboard?.organisation?.name || tenantName || "Organisation administration";
  return `<aside class="sidebar">
    <a class="brand press" href="${home}"><span class="brand-mark">${icon("shield", true)}</span><span class="brand-name">Whistleblower</span></a>
    <nav class="navigation admin-nav" aria-label="Administration">
      <div class="navigation-main">
        <span class="navigation-label">${platform ? "Platform" : "Organisation"}</span>
        <a class="nav-link is-current" aria-current="page" href="${path}">${icon(platform ? "landmark" : "users")} ${platform ? "Organisations" : joining ? "Invitation" : "Access & settings"}</a>
        ${platform ? "" : `<a class="nav-link press" href="${home}">${icon("home")} Reporting portal</a>`}
      </div>
      <div class="navigation-bottom">${state === "ready" ? '<button type="button" class="button button--secondary press" data-sign-out>Sign out</button>' : ""}</div>
    </nav>
  </aside>
  <div class="workspace">
    <header class="topbar admin-topbar"><span class="topbar-title">${esc(title)}</span>
      ${dashboard ? `<span class="case-reference">${esc(dashboard.user.email)}</span>` : ""}
    </header>
    <main id="main" tabindex="-1" class="main admin-page">${content}</main>
  </div>`;
}

function landingPage() {
  return `<div class="page-narrow page-narrow--small">
    ${intro("Whistleblower", "Open your organisation’s reporting portal.")}
    <form class="panel" data-operation="find">
      <div class="fields"><label>Organisation address
        <input name="slug" required maxlength="40" autocomplete="off" spellcheck="false" placeholder="Your organisation’s portal address">
      </label></div>${errorLine}
      <div class="form-actions form-actions--leading">${primary("Open reporting portal")}</div>
    </form>
    <a class="text-link return-link" href="/platform/">Platform Admin</a>
  </div>`;
}

function guestPage() {
  const title = joining ? "Accept your invitation" : platform ? "Platform Admin" : "Organisation Admin";
  const copy = joining ? "Enter your invitation code and choose a passphrase." : "Sign in to manage access and settings.";
  return `<div class="page-narrow page-narrow--small">${intro(title, copy)}
    <form class="panel" data-operation="${joining ? "accept" : "login"}">
      <div class="fields">
        ${joining ? '<label>Invitation code<input name="code" required autocomplete="off" spellcheck="false" maxlength="64"></label>' :
          '<label>Email address<input name="email" type="email" required maxlength="254" autocomplete="username"></label>'}
        <label>Passphrase<input name="password" type="password" required maxlength="512" ${joining ? 'minlength="14" autocomplete="new-password"' : 'autocomplete="current-password"'}></label>
      </div>${errorLine}
      <div class="form-actions form-actions--leading">${primary(joining ? "Accept invitation" : "Sign in")}</div>
    </form>
    ${!platform && !joining ? `<a class="text-link return-link" href="${tenantPrefix}/join/">Accept an invitation</a>` : ""}
  </div>`;
}

function invitationPanel() {
  if (!invitation) return "";
  return `<section class="panel invite-notice" aria-label="Invitation created">
    ${heading("Invitation created", `Share this one-time code privately with ${esc(invitation.email)}. It expires ${esc(date(invitation.expiresAt))}.`)}
    <div class="case-code"><code id="new-invite-code">${invitation.code}</code>
      <button class="button button--secondary press" type="button" data-copy>Copy code</button></div>
    <a class="text-link" href="${prefix(invitation.slug)}/join/">Invitation acceptance page</a>
    <div class="form-actions form-actions--leading"><button class="button button--secondary press" type="button" data-dismiss-invite>Done</button></div>
  </section>`;
}

function workspaceList() {
  const entries = dashboard.organisations.filter((org) => `${org.name} ${org.slug}`.toLowerCase().includes(filter.trim().toLowerCase()));
  if (!entries.length) return `<div class="panel empty-state"><h2>${filter ? "No matching organisations" : "No organisations yet"}</h2><p>${filter ? "Try a different name or portal address." : "Create an organisation to give it a reporting portal."}</p></div>`;
  return entries.map((org) => `<details class="guide-item admin-workspace">
    <summary><div><strong>${esc(org.name)}</strong><small>/o/${org.slug}/</small></div>
    ${rolePill(!org.active ? "Suspended" : org.hasAdministrator ? "Active" : "Awaiting setup", org.active && org.hasAdministrator)}${icon("chevron")}</summary>
    <div class="workspace-controls">
      ${org.active ? `<a class="button button--secondary press" href="${prefix(org.slug)}/">Open portal</a>` : ""}
      <button type="button" class="button button--secondary press" data-workspace="${org.slug}" data-active="${!org.active}">${org.active ? "Suspend organisation" : "Reactivate organisation"}</button>
    </div>
    ${org.active && !org.hasAdministrator ? `<form data-operation="setup-invite" data-slug="${org.slug}">
      <div class="fields"><label>Initial admin email<input type="email" name="email" required maxlength="254"></label></div>${errorLine}
      <div class="form-actions form-actions--leading">${primary("Replace setup invitation")}</div>
    </form>` : ""}</details>`).join("");
}

function backupPanel(data) {
  const labels = { healthy: "Healthy", starting: "Awaiting backup", attention: "Needs attention",
    unconfigured: "Setup required", configuration: "Check configuration" };
  const reasons = { storage: "Check the archive and key directories.", key: "Check availability and permissions of the original encryption key.",
    snapshot: "Check the source database, retained checkpoint and available storage.", recovery: "The archive failed its restore check.",
    retention: "Check archive retention permissions.", overdue: "The scheduled backup is overdue." };
  const configured = !["configuration", "unconfigured"].includes(data.state);
  return `<div class="anchor-heading"><h2 id="backup-title">Encrypted backups</h2>
    <span class="status status--${data.state === "healthy" ? "resolved" : "reviewing"}">${labels[data.state]}</span></div>
    <p class="anchor-detail">${configured ? `${data.protected} of ${data.scopes} databases have a restore-checked backup.`
      : data.state === "unconfigured" ? "Set separate archive and key directories on the SaaS service." : "Check the backup interval and retention settings."}</p>
    ${data.registryAt ? `<p class="anchor-meta">Last registry backup · ${esc(date(data.registryAt))}</p>` : ""}
    ${data.problems.length ? `<ul class="backup-alerts">${data.problems.map(problem => `<li><strong>${esc(problem.scope)}</strong> · ${reasons[problem.reason] || "Check the backup worker."}</li>`).join("")}</ul>` : ""}`;
}

function platformPage() {
  return `<div class="admin-intro">
    ${intro("Organisations", "Provision reporting portals and control organisation access.")}
    <button type="button" class="button button--primary press" aria-expanded="${showNew}" data-create>${showNew ? "Close setup" : "New organisation"}</button>
  </div>
  <p id="admin-error" class="form-error" role="alert" hidden></p>
  ${invitationPanel()}
  <section class="panel admin-section" aria-labelledby="backup-title"><div id="backup-status" aria-live="polite">${backupPanel(dashboard.backups)}</div>
    <p class="anchor-meta" id="backup-refresh-error" role="status" hidden>Couldn’t refresh backup status. Reconnecting…</p></section>
  ${showNew ? `<form class="panel admin-settings" data-operation="create">
    ${heading("Set up an organisation", "The initial administrator receives an invitation code.")}
    <div class="fields">
      <label>Organisation name<input name="name" required minlength="2" maxlength="100"></label>
      <label>Portal address<input name="slug" required maxlength="40" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" spellcheck="false" placeholder="example-organisation"></label>
      <label>Initial administrator email<input type="email" name="adminEmail" required maxlength="254"></label>
    </div>${errorLine}
    <div class="form-actions form-actions--leading">${primary("Create organisation")}</div>
  </form>` : ""}
  <div class="admin-filter"><label for="organisation-filter">Find an organisation</label>
    <input id="organisation-filter" type="search" value="${esc(filter)}" aria-keyshortcuts="Meta+K Control+K" placeholder="Search by name or portal address">
  </div>
  <section class="guide-list" aria-label="Organisation workspaces" id="workspace-list">${workspaceList()}</section>`;
}

function accessList(entries, pending) {
  if (!entries.length) return `<p class="admin-caption">${pending ? "No pending invitations." : "No team members yet."}</p>`;
  return `<ul class="admin-list">${entries.map((item) => `<li class="admin-row">
    <div><strong>${esc(item.email)}${item.id === dashboard.user.id ? " (you)" : ""}</strong>
      <small>${names[item.role]}${pending ? ` · Expires ${esc(date(item.expiresAt))}` : ""}</small></div>
    ${item.id === dashboard.user.id ? "" : `<button type="button" class="button button--secondary press" data-revoke="${item.id}" data-kind="${pending ? "invites" : "members"}">${pending ? "Cancel invitation" : "Revoke access"}</button>`}
  </li>`).join("")}</ul>`;
}

function anchorPanel(anchor) {
  const { state, verified } = anchor;
  const stages = {
    waiting: ["Awaiting first checkpoint", "The service will create the first checkpoint when this organisation has case history."],
    queued: ["Preparing checkpoint", "The service is submitting a commitment to OpenTimestamps."],
    pending: ["Awaiting Bitcoin confirmation", "The receipt is saved. Calendar confirmations can take several hours."],
    verifying: ["Verifying proof", "A calendar returned an attestation. The service is checking it against Bitcoin and this case history."],
    verified: ["Verified", "The checkpoint matches this organisation’s case history and a verified Bitcoin block."],
    retrying: ["Retry scheduled", { queued: "The checkpoint submission could not be completed.", pending: "The saved receipt could not be upgraded.", verifying: "Bitcoin verification could not be completed." }[anchor.phase]],
    check_failed: ["History check needs attention", "The latest case history check failed. The service will retry. Contact your platform operator if this continues."],
  };
  const [label, detail] = stages[state];
  const base = verified && tenantPrefix + "/api/admin/anchoring/" + verified.entries;
  return `<div class="anchor-heading"><h2 id="anchor-title">Bitcoin anchoring</h2>
    <span class="status status--${state === "verified" ? "resolved" : ["retrying", "check_failed"].includes(state) ? "reviewing" : "received"}">${label}</span></div>
    <p class="anchor-detail">${detail}</p>
    ${anchor.entries && state !== "verified" ? `<p class="anchor-meta">Latest checkpoint · ${anchor.entries} history entries</p>` : ""}
    ${state === "retrying" && anchor.retryAt ? `<p class="anchor-meta">Next attempt from ${esc(date(anchor.retryAt))}</p>` : ""}
    ${verified ? `<div class="anchor-proof">
      <strong>${state === "verified" ? "Bitcoin block" : "Last verified Bitcoin block"} ${verified.block.toLocaleString(undefined, { useGrouping: false })}</strong>
      <p class="anchor-meta">${verified.entries} history entries · Verified ${esc(date(verified.at))}</p>
      <div class="anchor-files"><a class="text-link" href="${base}/checkpoint" download>Download checkpoint</a>
        <a class="text-link" href="${base}/receipt" download>Download receipt</a></div>
      </div>` : ""}`;
}

function organisationPage() {
  return `${intro("Access & settings", `Manage the reporting portal for ${esc(dashboard.organisation.name)}.`)}
  <p id="admin-error" class="form-error" role="alert" hidden></p>
  ${invitationPanel()}
  <section class="panel admin-section admin-settings" aria-labelledby="anchor-title">
    <div id="anchor-status" aria-live="polite">${anchorPanel(dashboard.anchoring)}</div>
    <p class="anchor-meta" id="anchor-refresh-error" role="status" hidden>Couldn’t refresh anchoring status. Reconnecting…</p>
  </section>
  <section class="admin-section">
    <form class="panel admin-settings" data-operation="settings">${heading("Reporting portal")}
      <div class="fields"><label>Organisation name<input name="name" value="${esc(dashboard.organisation.name)}" required minlength="2" maxlength="100"></label></div>
      <label class="check-field"><input name="intakeOpen" type="checkbox" ${dashboard.organisation.intakeOpen ? "checked" : ""}> Accept new reports</label>
      ${errorLine}<div class="form-actions form-actions--leading">${primary("Save settings")}</div>
    </form>
  </section>
  <section class="admin-section">
    <form class="panel admin-settings" data-operation="invite">${heading("Invite a team member", "Choose the access they need for this organisation.")}
      <div class="field-columns fields">
        <label>Email address<input name="email" type="email" required maxlength="254"></label>
        <label>Role<select name="role"><option value="reviewer">Reviewer</option><option value="organisation_admin">Organisation Admin</option></select></label>
      </div>${errorLine}
      <div class="form-actions form-actions--leading">${primary("Create invitation")}</div>
    </form>
  </section>
  <section class="panel admin-section" aria-label="Active team members">${heading("Team members")}${accessList(dashboard.accounts, false)}</section>
  <section class="panel admin-section" aria-label="Pending invitations">${heading("Pending invitations")}${accessList(dashboard.invites, true)}</section>`;
}

function render(focus = false) {
  const content = landing ? landingPage() : state === "ready" ? (platform ? platformPage() : organisationPage()) : state === "guest" ? guestPage()
    : `<div class="page-narrow">${intro("Administration", state === "loading" ? "Loading your workspace…" : "We couldn’t load your workspace.")}
        ${state === "loading" ? '<div class="panel skeleton" role="status"><span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span></div>' :
          '<button type="button" class="button button--secondary press" data-retry>Try again</button>'}</div>`;
  app.innerHTML = shell(content);
  if (focus) app.querySelector("h1")?.focus();
}

async function api(endpoint, data) {
  const response = await fetch(scope + endpoint, data === undefined ? {} : { method: "POST", headers: {
    "Content-Type": "application/json",
  }, body: JSON.stringify(data) });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw Object.assign(new Error(result?.error || "Couldn’t reach the portal. Try again."), { status: response.status, field: result?.field });
  return result;
}

async function refresh() {
  try {
    dashboard = await api(platform ? "/api/admin/workspaces" : "/api/admin/settings");
    state = "ready";
  } catch (error) {
    dashboard = null;
    invitation = null;
    state = error.status === 401 ? "guest" : "error";
  }
  render(true);
}

let checkingStatus = false;
async function refreshStatus() {
  const current = dashboard;
  const field = platform ? "backups" : "anchoring";
  if (!current?.[field] || checkingStatus || document.hidden) return;
  const id = platform ? "backup" : "anchor";
  const format = platform ? backupPanel : anchorPanel;
  checkingStatus = true;
  try {
    const data = await api("/api/admin/" + field);
    if (current !== dashboard) return;
    const panel = document.getElementById(id + "-status");
    if (panel && JSON.stringify(data) !== JSON.stringify(current[field])) {
      const previous = format(current[field]);
      current[field] = data;
      const markup = format(data);
      if (previous !== markup) {
        const focused = panel.contains(document.activeElement) ? document.activeElement.getAttribute("href") : null;
        panel.innerHTML = markup;
        if (focused) Array.from(panel.querySelectorAll("a")).find(link => link.getAttribute("href") === focused)?.focus();
      }
    }
    document.getElementById(id + "-refresh-error").hidden = true;
  } catch (error) {
    if (current !== dashboard) return;
    if (error.status === 401 || error.status === 404) { await refresh(); return; }
    document.getElementById(id + "-refresh-error").hidden = false;
  } finally { checkingStatus = false; }
}
if (platform || (tenantPrefix && !joining)) {
  setInterval(refreshStatus, 30_000);
  document.addEventListener("visibilitychange", refreshStatus);
}

function showError(error, form) {
  const target = form?.querySelector(".form-error") ?? document.getElementById("admin-error");
  if (!target) return;
  target.textContent = error.message;
  target.hidden = false;
  if (error.field && form?.elements.namedItem(error.field)) form.elements.namedItem(error.field).focus();
}

function confirmAction(title, description, label, action) {
  dialog.innerHTML = `<h2 id="confirm-heading">${title}</h2><p>${description}</p>
    <div class="form-actions"><button class="button button--secondary press" type="button" data-cancel autofocus>Cancel</button>
      <button class="button button--primary press" type="button" data-confirm>${label}</button></div>`;
  dialog.querySelector("[data-cancel]").onclick = () => dialog.close();
  const confirm = dialog.querySelector("[data-confirm]");
  confirm.onclick = async () => {
    confirm.disabled = true;
    confirm.textContent = "Saving…";
    try {
      await action();
      dialog.close();
      await refresh();
    } catch (error) {
      dialog.close();
      if (error.status === 401) await refresh();
      else showError(error);
    }
  };
  dialog.showModal();
}

app.addEventListener("submit", async (event) => {
  const form = event.target;
  const operation = form.dataset.operation;
  if (!operation) return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const button = event.submitter;
  button.disabled = true;
  form.setAttribute("aria-busy", "true");
  form.querySelector(".form-error").hidden = true;
  try {
    if (operation === "find") {
      const slug = data.slug.trim().toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug)) throw new Error("Enter a valid organisation address.");
      const match = await fetch(prefix(slug) + "/", { method: "HEAD" });
      if (!match.ok) throw new Error("This organisation is unavailable. Check the address and try again.");
      location.assign(prefix(slug) + "/");
      return;
    }
    if (operation === "accept") {
      const result = await api("/api/auth/accept", data);
      location.assign(tenantPrefix + (result.role === "reviewer" ? "/#/reviewer" : "/admin/"));
      return;
    }
    if (operation === "login") await api("/api/admin/login", data);
    if (operation === "create") {
      const result = await api("/api/admin/workspaces", data);
      invitation = { ...result.invite, slug: result.organisation.slug };
      showNew = false;
      filter = "";
    }
    if (operation === "setup-invite") {
      const result = await api(`/api/admin/workspaces/${form.dataset.slug}/setup-invite`, data);
      invitation = { ...result.invite, slug: result.organisation.slug };
    }
    if (operation === "settings") await api("/api/admin/settings", { name: data.name, intakeOpen: form.elements.intakeOpen.checked });
    if (operation === "invite") {
      const result = await api("/api/admin/invites", data);
      invitation = { ...result.invite, slug: dashboard.organisation.slug };
    }
    await refresh();
    if (invitation) announce.textContent = "Invitation created.";
    else if (operation === "settings") announce.textContent = "Settings saved.";
  } catch (error) {
    showError(error, form);
  } finally {
    button.disabled = false;
    form.setAttribute("aria-busy", "false");
  }
});

app.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.hasAttribute("data-retry")) return await refresh();
  if (button.hasAttribute("data-create")) {
    showNew = !showNew;
    render();
    app.querySelector(showNew ? 'input[name="name"]' : "[data-create]")?.focus();
  }
  if (button.hasAttribute("data-dismiss-invite")) {
    invitation = null;
    render(true);
  }
  if (button.hasAttribute("data-copy")) {
    const code = document.querySelector("#new-invite-code");
    try {
      await navigator.clipboard.writeText(code.textContent);
      if (button.isConnected) button.textContent = "Copied";
      announce.textContent = "Invitation code copied.";
    } catch {
      window.getSelection().selectAllChildren(code);
      announce.textContent = "Copy the selected code.";
    }
  }
  if (button.hasAttribute("data-sign-out")) {
    button.disabled = true;
    try { await api("/api/admin/logout", {}); await refresh(); }
    catch (error) { showError(error); } finally { button.disabled = false; }
  }
  if (button.dataset.workspace) {
    const slug = button.dataset.workspace;
    const active = button.dataset.active === "true";
    confirmAction(active ? "Reactivate organisation?" : "Suspend organisation?",
      active ? "The organisation’s reporting portal and team access will reopen." : "The reporting portal will pause. Current team sessions will end.",
      active ? "Reactivate" : "Suspend", () => api(`/api/admin/workspaces/${slug}/access`, { active }));
  }
  if (button.dataset.revoke) {
    const member = button.dataset.kind === "members";
    confirmAction(member ? "Revoke access?" : "Cancel this invitation?",
      member ? "This team member’s active sessions will end." : "This invitation code will stop working.",
      member ? "Revoke access" : "Cancel invitation",
      () => api(`/api/admin/${button.dataset.kind}/${button.dataset.revoke}/revoke`, {}));
  }
});

app.addEventListener("input", (event) => {
  if (event.target.id !== "organisation-filter") return;
  filter = event.target.value;
  document.getElementById("workspace-list").innerHTML = workspaceList();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !dialog.open) {
    const search = document.getElementById("organisation-filter");
    if (search) { event.preventDefault(); search.focus(); }
  }
});

render();
if (!landing && !joining) void refresh();
