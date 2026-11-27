import { categories, statuses } from "./catalog.js";

const app = document.querySelector("#app");
const tenantPrefix = location.pathname.match(/^\/o\/[a-z0-9-]+(?=\/$)/)?.[0] || "";
const tenantName = document.querySelector('meta[name="whistleblower-organisation"]').content;
const dialog = document.querySelector("#search-dialog");
const announcer = document.querySelector("#announcer");

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const icon = (name, white = false) => `<span class="icon icon--${name}${white ? " icon--white" : ""}" aria-hidden="true"></span>`;
const categoryFor = (id) => categories.find((category) => category.id === id);
const prettyDate = (iso) => iso && new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium", ...(iso.includes("T") ? { timeStyle: "short" } : { timeZone: "UTC" }),
}).format(new Date(iso));
const statusPill = (status) => `<span class="status status--${status}"><span aria-hidden="true"></span>${statuses[status]}</span>`;
const tabs = [
  { route: "/", label: "Overview", icon: "home" },
  { route: "/report", label: "New report", icon: "filePlus" },
  { route: "/track", label: "Track a report", icon: "search" },
  { route: "/guide", label: "Reporting guide", icon: "book" },
  { route: "/reviewer", label: "Reviewer access", icon: "lock" },
];
const stepNames = ["Details", "Privacy", "Review"];

const freshDraft = () => ({
  category: "", summary: "", description: "", occurredOn: "", location: "", privacy: "anonymous", email: "", code: "", step: 1,
});

let draft = freshDraft();
const evidenceEnabled = document.querySelector('meta[name="whistleblower-evidence"]').content === "on";
let evidenceFiles = [];
let receipt = null;
let route = "";
let pageVersion = 0;
let tracking = { code: "", data: null };
let reviewer = { filter: "", page: 1, view: "loading", data: null, error: "" };

function announce(message) {
  announcer.textContent = message;
}

function currentRoute() {
  const hash = location.hash.slice(1) || "/";
  return /^\/(?:report|track|guide|reviewer)(?:\/WB-[0-9A-F]{16})?$/.test(hash)
    && (!hash.slice(1).includes("/") || hash.startsWith("/reviewer/"))
    ? hash
    : "/";
}

function navigate(next) {
  if (currentRoute() === next) {
    openRoute(next);
  } else {
    location.hash = next;
  }
}

function openRoute(next, initial = false) {
  const previous = route;
  if (previous === "/track" && next !== "/track") tracking = { code: "", data: null };
  if (previous === "/report" && next !== "/report") receipt = null;
  if (next.startsWith("/reviewer")) {
    if (!previous.startsWith("/reviewer")) reviewer = { filter: "", page: 1, view: "loading", data: null, error: "" };
    reviewer.view = "loading";
    reviewer.data = null;
  } else if (previous.startsWith("/reviewer")) {
    reviewer.data = null;
  }
  route = next;
  pageVersion += 1;
  draw();
  if (!initial) focusPage();
  if (route.startsWith("/reviewer")) void loadReviewer();
}

function focusPage() {
  document.querySelector("main h1")?.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function navItem({ route: path, label, icon: name }) {
  const selected = path === route || (path === "/reviewer" && route.startsWith("/reviewer/"));
  return `<a class="nav-link press${selected ? " is-current" : ""}" href="#${path}" ${selected ? 'aria-current="page"' : ""}>${icon(name)}<span>${label}</span></a>`;
}

function draw({ keepFocus = false } = {}) {
  const focused = keepFocus ? document.activeElement?.id : "";
  const tab = tabs.find(({ route: path }) => path === route) || tabs[4];
  document.title = `${tab.label} · Whistleblower`;
  app.innerHTML = `
    <aside class="sidebar">
      <a class="brand press" href="#/" aria-label="Whistleblower overview">
        <span class="brand-mark">${icon("shield", true)}</span>
        <span class="brand-label"><span class="brand-name">Whistleblower</span>
          ${tenantName ? `<span class="brand-organisation">${escapeHtml(tenantName)}</span>` : ""}</span>
      </a>
      <nav class="navigation" aria-label="Reporting portal">
        <div class="navigation-main">
          <span class="navigation-label">Workspace</span>
          ${tabs.slice(0, 4).map(navItem).join("")}
        </div>
        <div class="navigation-bottom">
          ${navItem(tabs[4])}
          ${tenantPrefix ? `<a class="nav-link press" href="${tenantPrefix}/admin/">${icon("lock")}<span>Organisation admin</span></a>` : ""}
        </div>
      </nav>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <span class="topbar-title">${tenantName ? escapeHtml(tenantName) : "Reporting portal"}</span>
        <button type="button" class="search-trigger press" id="open-search" data-action="search" aria-label="Search the portal" aria-keyshortcuts="Meta+K Control+K">
          ${icon("search")}<span>Search</span><kbd>⌘ K</kbd>
        </button>
      </header>
      <main id="main" tabindex="-1" class="main ${route === "/" ? "main--home" : ""}">
        ${route === "/" ? overview() : route === "/report" ? reportPage() : route === "/track" ? trackingPage() : route === "/guide" ? guidePage() : reviewerPage()}
      </main>
    </div>`;
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
}

function overview() {
  return `
    <section class="hero" aria-labelledby="overview-title">
      <div class="hero-art" aria-hidden="true"></div>
      <div class="hero-text">
        <span class="hero-tag">${icon("shield")} Workplace reporting</span>
        <h1 id="overview-title" tabindex="-1">Speak up.<br>Be heard.</h1>
        <p>Report misconduct at work and follow up with a private case code. You can choose to stay anonymous.</p>
        <a class="button button--primary press" href="#/report">${icon("filePlus", true)} Start a report</a>
      </div>
    </section>
    <section class="categories-section" aria-labelledby="category-heading">
      <div class="section-heading">
        <h2 id="category-heading">What would you like to report?</h2>
        <p>Choose the category that best fits your concern.</p>
      </div>
      <div class="category-grid">
        ${categories.map((category) => `
          <button type="button" class="category-card press" data-category="${category.id}">
            <span class="tile-icon tile-icon--${category.tone}">${icon(category.icon)}</span>
            <span class="category-title">${category.title}</span>
            <span class="category-description">${category.description}</span>
          </button>`).join("")}
      </div>
    </section>
    <section class="track-strip" aria-labelledby="track-strip-label">
      <span class="tile-icon tile-icon--leaf">${icon("key")}</span>
      <div>
        <h2 id="track-strip-label">Already submitted a report?</h2>
        <p>Use your case code to see updates or message a reviewer.</p>
      </div>
      <a class="button button--secondary press" href="#/track">Track a report</a>
    </section>
    ${location.protocol === "https:" ? "" : `<footer class="portal-footer">${icon("info")} Local prototype · Use sample information only</footer>`}`;
}

function pageIntro(title, description, marker = "") {
  return `<div class="page-intro">
    ${marker ? `<span class="tile-icon tile-icon--leaf">${icon(marker)}</span>` : ""}
    <h1 tabindex="-1">${title}</h1>
    <p>${description}</p>
  </div>`;
}

function reportPage() {
  if (receipt) return receiptPage();
  const steps = stepNames.map((label, index) => {
    const step = index + 1;
    return `<li class="${step <= draft.step ? "step-reached" : ""}" ${step === draft.step ? 'aria-current="step"' : ""}>
      <span class="step-count">${step < draft.step ? icon("check", true) : step}</span><span>${label}</span>
    </li>`;
  }).join("");
  return `<div class="page-narrow">
    ${pageIntro("New report", "Tell us what happened. Share as much as you feel comfortable sharing.")}
    <ol class="stepper" aria-label="Report progress">${steps}</ol>
    <form class="panel report-panel" id="report-form" autocomplete="off">
      ${[detailsStep, privacyStep, reviewStep][draft.step - 1]()}
      <p class="form-error" id="report-error" role="alert" hidden></p>
      <div class="form-actions">
        ${draft.step > 1
          ? '<button class="button button--secondary press" data-action="previous-step" type="button">Back</button>'
          : '<a class="button button--secondary press" href="#/">Cancel</a>'}
        <button data-progress="${draft.step === 3 ? "Submitting…" : ""}" class="button button--primary press" type="submit">${draft.step === 3 ? "Submit report" : "Continue"}</button>
      </div>
    </form>
    ${location.protocol === "https:" ? "" : `<p class="panel-footnote">${icon("info")} Local prototype. Please use sample information only.</p>`}
  </div>`;
}

function selectedFiles() {
  return evidenceFiles.map((file, index) => `<li><span>${escapeHtml(file.name)}</span>
    <button type="button" class="button button--secondary press" data-remove-file="${index}" aria-label="Remove ${escapeHtml(file.name)}">Remove</button></li>`).join("");
}

function evidenceField() {
  return `<div class="evidence-field">
    <label for="evidence-files">Supporting evidence <span class="optional">Optional</span></label>
    <p class="field-hint" id="evidence-help">Choose up to 3 JPEG, PNG, WebP or plain-text files. Each can be up to 4 MiB, with 8 MiB total. Original files may include identifying details, such as photo location.</p>
    <input id="evidence-files" type="file" multiple accept=".jpg,.jpeg,.png,.webp,.txt" aria-describedby="evidence-help evidence-error">
    <ul class="evidence-files" id="selected-files">${selectedFiles()}</ul>
    <p class="form-error" id="evidence-error" role="alert" hidden></p>
  </div>`;
}

function encodedFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, data: reader.result.split(",")[1] });
    reader.onerror = reader.onabort = () => reject(new Error("This file could not be read. Choose it again."));
    reader.readAsDataURL(file);
  });
}

function detailsStep() {
  return `
    <div class="panel-heading"><h2 tabindex="-1">What happened?</h2><p>Include details that would help a reviewer understand the concern.</p></div>
    <div class="fields">
      <label for="category">Category
        <select name="category" id="category" required>
          <option value="" ${draft.category ? "" : "selected"} disabled>Choose a category</option>
          ${categories.map(({ id, title }) => `<option value="${id}" ${draft.category === id ? "selected" : ""}>${title}</option>`).join("")}
        </select>
      </label>
      <label for="summary">Short summary
        <input type="text" name="summary" id="summary" required minlength="5" maxlength="100" placeholder="A brief title for the report" value="${escapeHtml(draft.summary)}" />
      </label>
      <label for="description"><span id="description-label">What happened?</span>
        <textarea name="description" id="description" aria-labelledby="description-label" aria-describedby="description-count" minlength="10" maxlength="5000" required rows="6" placeholder="Describe what happened in your own words.">${escapeHtml(draft.description)}</textarea>
        <span class="field-hint" id="description-count">${draft.description.length} / 5,000</span>
      </label>
      <div class="field-columns">
        <label for="occurredOn">Date <span class="optional">Optional</span>
          <input type="date" name="occurredOn" id="occurredOn" value="${escapeHtml(draft.occurredOn)}" />
        </label>
        <label for="location">Location <span class="optional">Optional</span>
          <input type="text" name="location" id="location" maxlength="120" placeholder="Office, department or online" value="${escapeHtml(draft.location)}" />
        </label>
      </div>
      ${evidenceEnabled ? evidenceField() : ""}
    </div>`;
}

function privacyStep() {
  return `
    <div class="panel-heading"><h2 tabindex="-1">How would you like to report?</h2><p>You can receive replies with a case code either way.</p></div>
    <fieldset class="privacy-choices">
      <legend class="sr-only">Identity preference</legend>
      <label class="choice">
        <input name="privacy" type="radio" value="anonymous" ${draft.privacy === "anonymous" ? "checked" : ""} />
        <span><strong>Report anonymously</strong><span>No contact details will be requested.</span></span>
      </label>
      <label class="choice">
        <input name="privacy" type="radio" value="contact" ${draft.privacy === "contact" ? "checked" : ""} />
        <span><strong>Share an email address</strong><span>The reviewer will be able to see your email address.</span></span>
      </label>
    </fieldset>
    <label class="standalone-field" for="email" id="email-field" ${draft.privacy === "anonymous" ? "hidden" : ""}>Email address
      <input type="email" name="email" id="email" autocomplete="off" maxlength="254" ${draft.privacy === "anonymous" ? "disabled" : "required"} value="${escapeHtml(draft.email)}" />
    </label>
    <p class="notice">${icon("info")} Details in your report can identify you. If you want to stay anonymous, review your wording before you submit.</p>`;
}

function detailRow(label, value) {
  return `<div><dt>${label}</dt><dd>${value}</dd></div>`;
}

function reviewStep() {
  return `
    <div class="panel-heading"><h2 tabindex="-1">Review your report</h2><p>Check what will be shared with the reviewer.</p></div>
    <dl class="detail-list">
      ${detailRow("Category", categoryFor(draft.category).title)}
      ${detailRow("Summary", escapeHtml(draft.summary.trim()))}
      ${detailRow("Description", escapeHtml(draft.description.trim()))}
      ${draft.occurredOn ? detailRow("Date", prettyDate(draft.occurredOn)) : ""}
      ${draft.location.trim() ? detailRow("Location", escapeHtml(draft.location.trim())) : ""}
      ${evidenceFiles.length ? detailRow("Evidence", evidenceFiles.map(file => escapeHtml(file.name)).join("<br>")) : ""}
      ${detailRow("Identity", draft.privacy === "anonymous" ? "Anonymous" : escapeHtml(draft.email.trim()))}
    </dl>`;
}

function receiptPage() {
  return `<div class="page-narrow">
    ${pageIntro("Report submitted", "Use your case code to read updates and send follow-up messages.", "check")}
    <section class="panel receipt-panel" aria-labelledby="case-code-heading">
      <div class="panel-heading"><h2 id="case-code-heading">Save your case code</h2><p>Store this code somewhere safe. Anyone with it can access the follow-up conversation.</p></div>
      <div class="case-code">
        <code id="issued-code">${escapeHtml(receipt.code)}</code>
        <button class="button button--secondary press" type="button" id="copy-code" data-action="copy-code">${icon("copy")} Copy code</button>
      </div>
      <p class="form-error" id="copy-error" role="alert" hidden></p>
      <p class="field-hint" id="copy-status" role="status"></p>
      <div class="form-actions form-actions--leading">
        <button class="button button--primary press" type="button" data-action="open-receipt">Track this report</button>
      </div>
    </section>
  </div>`;
}

function trackingPage() {
  if (tracking.data) {
    return `<div class="page-narrow">
      ${pageIntro("Track a report", "Review the case status and communicate with the reviewer.")}
      ${caseHeader(tracking.data)}
      ${timeline(tracking.data, "reporter")}
      ${messageForm(tracking.data, "reporter")}
      <div class="page-end"><button type="button" class="button button--secondary press" data-action="close-tracking">Close case view</button></div>
    </div>`;
  }
  return `<div class="page-narrow page-narrow--small">
    ${pageIntro("Track a report", "Enter the case code you received when you submitted your report.", "key")}
    <form class="panel" id="tracking-form" autocomplete="off">
      <div class="fields">
        <label for="tracking-code">Case code
          <input type="text" class="monospace" name="code" id="tracking-code" required maxlength="96" spellcheck="false" autocapitalize="characters" placeholder="${tenantPrefix ? `WB/${tenantPrefix.slice(3)}/…` : "WB-…"}" value="${escapeHtml(tracking.code)}" aria-describedby="tracking-hint" />
          <span id="tracking-hint" class="field-hint">${tenantPrefix ? "Paste the full code, including the organisation address." : "You can paste the code with or without hyphens."}</span>
        </label>
      </div>
      <p class="form-error" id="tracking-error" role="alert" hidden></p>
      <div class="form-actions form-actions--leading">
        <button class="button button--primary press" data-progress="Looking up report…" type="submit">View report</button>
      </div>
    </form>
  </div>`;
}

function guidePage() {
  const questions = [
    ["What can I report?", "Report workplace misconduct, including sexual harassment, bribery, bullying, discrimination, fraud, theft, unsafe working conditions and retaliation. Choose Other misconduct if the categories don’t fit."],
    ["What should I include?", "Describe what happened, when and where it happened, and anything else that would help a reviewer understand your concern. If you choose to report anonymously, consider whether any details could identify you."],
    ["What happens after I submit?", "You’ll receive a case code. Save it somewhere safe, then use Track a report to see the status, read replies or send a follow-up. Keep the code private."],
    ["Who can see my report?", "The reviewer can see the report details and any email address you choose to provide. A person with your case code can see the report summary, status and follow-up conversation."],
    ["Can I recover a lost case code?", "The portal does not store recoverable case codes. Copy your code before leaving the confirmation page."],
  ];
  return `<div class="page-narrow">
    ${pageIntro("Reporting guide", "What to share, how anonymity works and what to expect after you submit.", "book")}
    <div class="guide-list">
      ${questions.map(([question, answer]) => `<details class="guide-item">
        <summary>${question}${icon("chevron")}</summary><p>${answer}</p>
      </details>`).join("")}
    </div>
    <div class="page-end"><a class="button button--primary press" href="#/report">Start a report</a></div>
  </div>`;
}

function caseHeader(data) {
  return `<section class="panel case-heading" aria-labelledby="case-title">
    <div class="case-heading-top"><span class="case-reference">${escapeHtml(data.reference)}</span>${statusPill(data.status)}</div>
    <h2 id="case-title">${escapeHtml(data.summary)}</h2>
    <p>${categoryFor(data.category).title} <span aria-hidden="true">·</span> ${prettyDate(data.createdAt)}</p>
  </section>`;
}

function timeline(data, viewer) {
  return `<section class="panel" aria-labelledby="case-activity-heading">
    <div class="panel-heading"><h2 id="case-activity-heading">Case activity</h2></div>
    <ol class="timeline">${data.events.map((event) => {
      const title = event.kind === "status"
        ? (event.actor === "system" ? "Report received" : `Status changed to ${statuses[event.value].toLowerCase()}`)
        : event.actor === viewer ? "You" : event.actor === "reviewer" ? "Reviewer" : "Reporter";
      return `<li>
        <span class="timeline-icon">${icon(event.kind === "message" ? "message" : "check")}</span>
        <div><h3>${title}</h3><time datetime="${escapeHtml(event.createdAt)}">${prettyDate(event.createdAt)}</time>
        ${event.kind === "message" ? `<p>${escapeHtml(event.value)}</p>` : ""}</div>
      </li>`;
    }).join("")}</ol>
  </section>`;
}

function messageForm(data, viewer) {
  if (data.status === "resolved") return `<p class="notice">${icon("info")} This report is resolved. Messaging is closed.</p>`;
  return `<form class="panel" id="message-form" data-viewer="${viewer}" autocomplete="off">
    <div class="fields">
      <label for="case-message">Send a follow-up
        <textarea id="case-message" name="message" rows="4" maxlength="2500" required placeholder="Write a message…"></textarea>
      </label>
    </div>
    <p class="form-error" id="message-error" role="alert" hidden></p>
    <div class="form-actions form-actions--leading">
      <button class="button button--primary press" data-progress="Sending…" type="submit">Send message</button>
    </div>
  </form>`;
}

function reviewerPage() {
  if (reviewer.view === "loading") return `<div class="page-narrow">${pageIntro("Reviewer inbox", "Review reports and respond to follow-ups.")}${skeleton()}</div>`;
  if (reviewer.view === "error") return `<div class="page-narrow">
    ${pageIntro("Reviewer inbox", "Review reports and respond to follow-ups.")}
    <div class="panel empty-state"><h2>There was a problem loading this page</h2><p>${escapeHtml(reviewer.error)}</p>
      <button class="button button--secondary press" type="button" data-action="retry-reviewer">Try again</button>
      ${route !== "/reviewer" ? '<a class="button button--secondary press" href="#/reviewer">Inbox</a>' : ""}
    </div></div>`;
  if (reviewer.view === "login") return `<div class="page-narrow page-narrow--small">
    ${pageIntro("Reviewer access", "Sign in to review reports for this workspace.", "lock")}
    <form class="panel" id="login-form">
      <div class="fields">
      ${tenantPrefix ? '<label for="reviewer-email">Email address<input id="reviewer-email" name="email" type="email" autocomplete="username" maxlength="254" required /></label>' : ""}
      <label for="password">Reviewer passphrase
        <input id="password" name="password" type="password" autocomplete="current-password" maxlength="512" required />
      </label></div>
      <p class="form-error" id="login-error" role="alert" hidden></p>
      <div class="form-actions form-actions--leading">
        <button class="button button--primary press" data-progress="Signing in…" type="submit">Sign in</button>
      </div>
    </form>
    ${tenantPrefix ? `<p class="page-end"><a class="text-link return-link" href="${tenantPrefix}/join/">Accept an invitation</a></p>` : ""}
  </div>`;
  return route === "/reviewer" ? reviewerInbox() : reviewerCase();
}

function skeleton() {
  return `<div class="panel skeleton" role="status"><span class="sr-only">Loading reports…</span>
    <span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span>
  </div>`;
}

function reviewerInbox() {
  const { reports, total, page, pages } = reviewer.data;
  return `<div class="page-narrow page-narrow--inbox">
    <div class="inbox-header">
      ${pageIntro("Reviewer inbox", "Review reports, update their status and respond to follow-ups.")}
      <button type="button" class="button button--secondary press" data-action="logout">Sign out</button>
    </div>
    <p class="form-error" id="logout-error" role="alert" hidden></p>
    <div class="inbox-toolbar">
      <label for="reviewer-filter">Status <select id="reviewer-filter" name="filter">
        <option value="" ${!reviewer.filter ? "selected" : ""}>All statuses</option>
        ${Object.entries(statuses).map(([id, name]) => `<option value="${id}" ${reviewer.filter === id ? "selected" : ""}>${name}</option>`).join("")}
      </select></label>
      <span role="status">${total} ${total === 1 ? "report" : "reports"}</span>
    </div>
    ${reports.length ? `<ul class="inbox-list">${reports.map((report) => `
      <li><a class="inbox-row press" href="#/reviewer/${report.reference}">
        <div><span class="case-reference">${report.reference}</span><strong>${escapeHtml(report.summary)}</strong><span>${categoryFor(report.category).title}</span></div>
        <div>${statusPill(report.status)}<time datetime="${escapeHtml(report.updatedAt)}">${prettyDate(report.updatedAt)}</time></div>
      </a></li>`).join("")}</ul>`
      : `<div class="panel empty-state">
          <span class="tile-icon tile-icon--leaf">${icon("fileSearch")}</span>
          <h2>${reviewer.filter ? "No reports with this status" : "No reports yet"}</h2>
          <p>${reviewer.filter ? "Choose a different status to view more reports." : "New submissions will appear here."}</p>
        </div>`}
    ${pages > 1 ? `<div class="pagination" aria-label="Report pages">
      <button class="button button--secondary press" data-page="${page - 1}" type="button" ${page <= 1 ? "disabled" : ""}>Previous</button>
      <span>Page ${page} of ${pages}</span>
      <button class="button button--secondary press" data-page="${page + 1}" type="button" ${page >= pages ? "disabled" : ""}>Next</button>
    </div>` : ""}
  </div>`;
}

function reviewerEvidence(data) {
  if (data.evidenceError) return `<section class="panel"><h2>Supporting evidence</h2><p role="alert">${escapeHtml(data.evidenceError)}</p></section>`;
  if (!data.evidence?.length) return "";
  return `<section class="panel"><div class="panel-heading"><h2>Supporting evidence</h2></div>
    <ul class="evidence-files">${data.evidence.map(file => {
      const path = tenantPrefix + "/api/reviewer/reports/" + encodeURIComponent(data.reference) + "/evidence/" + encodeURIComponent(file.id);
      return `<li><div><strong>${escapeHtml(file.name)}</strong><span class="field-hint">${Math.ceil(file.bytes / 1024)} KiB${file.truncated ? " · Preview shows an excerpt" : ""}</span></div>
        <div class="evidence-actions"><a class="button button--secondary press" href="${path}/preview" target="_blank" rel="noopener" aria-label="Open preview of ${escapeHtml(file.name)} in a new tab">Preview</a>
        <a class="text-link" href="${path}/original">Download original</a></div></li>`;
    }).join("")}</ul></section>`;
}

function reviewerCase() {
  const data = reviewer.data;
  return `<div class="page-narrow">
    <a class="text-link return-link" href="#/reviewer">Reviewer inbox</a>
    ${pageIntro("Review report", "Report details and follow-up conversation.")}
    ${caseHeader(data)}
    <section class="panel" aria-labelledby="reported-details">
      <div class="panel-heading"><h2 id="reported-details">Reported details</h2></div>
      <dl class="detail-list">
        ${detailRow("Description", escapeHtml(data.description))}
        ${data.occurredOn ? detailRow("Date", prettyDate(data.occurredOn)) : ""}
        ${data.location ? detailRow("Location", escapeHtml(data.location)) : ""}
        ${detailRow("Contact", data.contactEmail ? escapeHtml(data.contactEmail) : "Anonymous")}
      </dl>
    </section>
    ${reviewerEvidence(data)}
    <form class="panel" id="status-form">
      <div class="fields"><label for="case-status">Update status
        <select id="case-status" name="status">
          ${Object.entries(statuses).map(([id, name]) => `<option value="${id}" ${data.status === id ? "selected" : ""}>${name}</option>`).join("")}
        </select>
      </label></div>
      <p class="form-error" id="status-error" role="alert" hidden></p>
      <div class="form-actions form-actions--leading">
        <button type="submit" class="button button--secondary press" data-progress="Saving…">Save status</button>
      </div>
    </form>
    ${timeline(data, "reviewer")}
    ${messageForm(data, "reviewer")}
  </div>`;
}

async function request(path, body) {
  let response;
  try {
    response = await fetch(tenantPrefix + path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch {
    throw new Error("The portal couldn’t be reached. Check your connection and try again.");
  }
  const data = await response.json().catch(() => null);
  if (!data) throw new Error("The portal returned an unexpected response. Try again in a moment.");
  if (!response.ok) throw Object.assign(new Error(data.error || "Something went wrong. Try again."), { status: response.status, field: data.field });
  return data;
}

function showError(id, error, form) {
  const target = document.getElementById(id);
  if (!target) return;
  target.textContent = error.message || "Something went wrong. Try again.";
  target.hidden = false;
  if (!error.field || !form) return;
  const field = form.elements.namedItem(error.field);
  if (field instanceof HTMLElement) {
    field.setAttribute("aria-invalid", "true");
    const description = field.getAttribute("aria-describedby")?.split(" ") ?? [];
    if (!description.includes(id)) field.setAttribute("aria-describedby", [...description, id].join(" "));
    field.focus();
  }
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.closest("form")?.setAttribute("aria-busy", String(busy));
  if (busy && button.dataset.progress) {
    button.dataset.defaultText = button.textContent;
    button.textContent = button.dataset.progress;
  } else if (button.dataset.defaultText) {
    button.textContent = button.dataset.defaultText;
    delete button.dataset.defaultText;
  }
}

async function loadReviewer({ focus = false } = {}) {
  const version = pageVersion;
  const reference = route.split("/")[2];
  const path = reference ? `/api/reviewer/reports/${reference}`
    : `/api/reviewer/reports?status=${reviewer.filter}&page=${reviewer.page}`;
  try {
    const data = await request(path);
    if (version !== pageVersion) return;
    reviewer.data = data;
    reviewer.view = "ready";
  } catch (error) {
    if (version !== pageVersion) return;
    reviewer.view = error.status === 401 ? "login" : "error";
    reviewer.error = error.message;
  }
  const headingHadFocus = document.activeElement === document.querySelector("main h1");
  draw();
  if (focus || headingHadFocus) document.querySelector("main h1")?.focus({ preventScroll: true });
}

function refreshReviewer() {
  pageVersion += 1;
  reviewer.view = "loading";
  draw();
  document.querySelector("main h1")?.focus({ preventScroll: true });
  void loadReviewer({ focus: true });
}

function randomCode() {
  const bytes = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0"));
  const prefix = tenantPrefix ? `WB/${tenantPrefix.slice(3)}/` : "WB-";
  return prefix + bytes.join("").toUpperCase().match(/.{4}/g).join("-");
}

function nextStep(step) {
  draft.step = step;
  draw();
  document.querySelector(".panel-heading h2")?.focus();
}

function openSearch(trigger) {
  if (dialog.open) return;
  const choices = tabs.map((tab) => ({ ...tab, kind: "Page" })).concat(categories.map((category) => ({
    route: "/report", label: category.title, icon: category.icon, category: category.id, kind: "Category",
  })));
  dialog.innerHTML = `<div class="search-heading">
    <h2 id="search-heading">Search the portal</h2>
    <button class="icon-button press" type="button" data-search-close aria-label="Close search">${icon("close")}</button>
  </div>
  <label for="search-input" class="sr-only">Search pages and categories</label>
  <input id="search-input" type="search" autocomplete="off" placeholder="Search pages and categories…" />
  <div id="search-results" class="search-results"></div>`;

  const input = dialog.querySelector("input");
  const results = dialog.querySelector("#search-results");
  const populate = () => {
    const query = input.value.trim().toLocaleLowerCase();
    const filtered = choices.filter((choice) => choice.label.toLocaleLowerCase().includes(query));
    results.innerHTML = filtered.length ? filtered.map((item) => `<button class="search-result" type="button" data-search-route="${item.route}" ${item.category ? `data-search-category="${item.category}"` : ""}>
      ${icon(item.icon)}<span>${item.label}</span><small>${item.kind}</small>
    </button>`).join("") : '<p class="search-empty" role="status">No matching pages or categories.</p>';
  };

  input.addEventListener("input", populate);
  dialog.onclick = (event) => {
    if (event.target === dialog || event.target.closest("[data-search-close]")) dialog.close();
    const item = event.target.closest("[data-search-route]");
    if (!item) return;
    dialog.close();
    if (item.dataset.searchCategory) chooseCategory(item.dataset.searchCategory);
    else navigate(item.dataset.searchRoute);
  };
  dialog.onkeydown = (event) => {
    const buttons = Array.from(results.querySelectorAll("button"));
    const index = buttons.indexOf(document.activeElement);
    if (event.key === "Enter" && event.target === input && buttons[0]) {
      event.preventDefault();
      buttons[0].click();
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (!buttons.length) return;
    event.preventDefault();
    const next = event.key === "ArrowDown" ? index + 1 : index < 0 ? buttons.length - 1 : index - 1;
    (buttons[next] || input).focus();
  };
  dialog.onclose = () => {
    if (trigger?.isConnected && !document.activeElement?.closest("main")) trigger.focus({ preventScroll: true });
  };
  populate();
  dialog.showModal();
  input.focus();
}

function chooseCategory(id) {
  draft.category = id;
  draft.step = 1;
  receipt = null;
  navigate("/report");
}

document.querySelector(".skip-link").addEventListener("click", (event) => {
  event.preventDefault();
  document.querySelector("main")?.focus();
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (dialog.open) dialog.close();
    else openSearch(document.activeElement);
  }
});

app.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.hasAttribute("data-remove-file")) {
    evidenceFiles.splice(Number(button.dataset.removeFile), 1);
    document.getElementById("selected-files").innerHTML = selectedFiles();
    document.getElementById("evidence-error").hidden = true;
    document.getElementById("evidence-files").focus();
    announce("File removed.");
    return;
  }
  if (button.dataset.category) return chooseCategory(button.dataset.category);
  if (button.dataset.page) {
    reviewer.page = Number(button.dataset.page);
    return refreshReviewer();
  }
  switch (button.dataset.action) {
    case "search":
      return openSearch(button);
    case "previous-step":
      return nextStep(draft.step - 1);
    case "copy-code": {
      const version = pageVersion;
      try {
        await navigator.clipboard.writeText(receipt.code);
        if (version !== pageVersion) return;
        const status = document.querySelector("#copy-status");
        if (status) status.textContent = "Case code copied.";
        button.innerHTML = `${icon("check")} Copied`;
      } catch {
        if (version !== pageVersion) return;
        document.getElementById("copy-error").textContent = "Copy the case code manually.";
        document.getElementById("copy-error").hidden = false;
        const range = document.createRange();
        range.selectNodeContents(document.querySelector("#issued-code"));
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
      }
      return;
    }
    case "open-receipt":
      tracking = { code: receipt.code, data: null };
      return navigate("/track");
    case "close-tracking":
      tracking = { code: "", data: null };
      return openRoute("/track");
    case "retry-reviewer":
      return refreshReviewer();
    case "logout": {
      setBusy(button, true);
      const version = pageVersion;
      try {
        await request("/api/reviewer/logout", {});
        if (version !== pageVersion) return;
        reviewer.data = null;
        reviewer.view = "login";
        draw();
        focusPage();
        announce("Signed out.");
      } catch (error) {
        if (version === pageVersion) showError("logout-error", error);
      } finally {
        setBusy(button, false);
      }
      return;
    }
  }
});

app.addEventListener("input", (event) => {
  const field = event.target;
  field.removeAttribute("aria-invalid");
  if (field.form?.id === "report-form" && Object.hasOwn(draft, field.name)) {
    draft[field.name] = field.value;
    if (field.name === "description") document.getElementById("description-count").textContent = `${field.value.length} / 5,000`;
    if (field.name === "privacy") {
      const email = document.getElementById("email");
      const anonymous = field.value === "anonymous";
      document.getElementById("email-field").hidden = anonymous;
      email.disabled = anonymous;
      email.required = !anonymous;
      if (anonymous) draft.email = email.value = "";
    }
  }
  if (field.id === "case-message") {
    if (field.dataset.pending !== field.value.trim()) {
      delete field.dataset.clientId;
      delete field.dataset.pending;
    }
  }
});

app.addEventListener("change", (event) => {
  if (event.target.id === "evidence-files") {
    const files = [...evidenceFiles, ...event.target.files];
    const message = files.length > 3 ? "Choose up to three evidence files."
      : files.some(file => !/\.(jpe?g|png|webp|txt)$/i.test(file.name)) ? "Choose a JPEG, PNG, WebP or .txt file."
      : files.some(file => !file.size || file.size > 4 * 1024 ** 2 || file.name.length > 180) ? "Use nonempty files up to 4 MiB with names up to 180 characters."
      : files.reduce((total, file) => total + file.size, 0) > 8 * 1024 ** 2 ? "Choose up to 8 MiB in total." : "";
    const error = document.getElementById("evidence-error");
    error.hidden = !message;
    error.textContent = message;
    event.target.value = "";
    if (!message) {
      evidenceFiles = files;
      document.getElementById("selected-files").innerHTML = selectedFiles();
      announce(files.length + " evidence files selected.");
    }
    return;
  }
  if (event.target.id === "reviewer-filter") {
    reviewer.filter = event.target.value;
    reviewer.page = 1;
    refreshReviewer();
  }
});

app.addEventListener("submit", async (event) => {
  const form = event.target;
  event.preventDefault();
  if (form.getAttribute("aria-busy") === "true") return;
  const button = event.submitter || form.querySelector('button[type="submit"]');
  const version = pageVersion;
  const values = Object.fromEntries(new FormData(form));
  const errors = {
    "report-form": "report-error", "tracking-form": "tracking-error", "login-form": "login-error",
    "message-form": "message-error", "status-form": "status-error",
  };
  const errorId = errors[form.id];
  if (!errorId) return;
  document.getElementById(errorId).hidden = true;
  if (form.id === "report-form" && draft.step < 3) {
    Object.assign(draft, values);
    if (draft.step === 1 && draft.summary.trim().length < 5) return showError(errorId, { message: "Enter a summary using at least 5 characters.", field: "summary" }, form);
    if (draft.step === 1 && draft.description.trim().length < 10) return showError(errorId, { message: "Describe what happened using at least 10 characters.", field: "description" }, form);
    return nextStep(draft.step + 1);
  }
  const companionForm = form.id === "status-form" ? "message-form"
    : form.id === "message-form" && form.dataset.viewer === "reviewer" ? "status-form" : "";
  const companionButton = companionForm ? document.querySelector(`#${companionForm} button[type="submit"]`) : null;
  if (companionButton?.closest("form")?.getAttribute("aria-busy") === "true") return;
  const disabledDuringSubmit = Array.from(form.elements).filter((element) => element !== button && !element.disabled);
  if (companionButton && !companionButton.disabled) disabledDuringSubmit.push(companionButton);
  for (const control of disabledDuringSubmit) control.disabled = true;
  setBusy(button, true);
  try {
    let result;
    let success = "";
    let focus = "h1";
    switch (form.id) {
      case "report-form": {
        draft.code ||= randomCode();
        const code = draft.code;
        result = evidenceFiles.length
          ? await request("/api/reports/with-evidence", { ...draft, code, evidence: await Promise.all(evidenceFiles.map(encodedFile)) })
          : await request("/api/reports", { ...draft, code });
        if (version !== pageVersion) return;
        receipt = { ...result, code };
        draft = freshDraft();
        evidenceFiles = [];
        success = "Report submitted.";
        break;
      }
      case "tracking-form":
        tracking.code = values.code.trim();
        result = await request("/api/track", { code: tracking.code });
        if (version !== pageVersion) return;
        tracking.data = result;
        success = "Report found.";
        break;
      case "login-form":
        await request("/api/reviewer/login", values);
        if (version !== pageVersion) return;
        return refreshReviewer();
      case "status-form":
        result = await request(`/api/reviewer/reports/${reviewer.data.reference}/status`, values);
        if (version !== pageVersion) return;
        reviewer.data = result;
        success = "Case status saved.";
        focus = "#case-status";
        break;
      case "message-form": {
        const field = form.elements.message;
        field.dataset.pending = values.message.trim();
        field.dataset.clientId ||= crypto.randomUUID();
        const payload = { ...values, clientId: field.dataset.clientId };
        if (form.dataset.viewer === "reviewer") {
          result = await request(`/api/reviewer/reports/${reviewer.data.reference}/message`, payload);
          if (version !== pageVersion) return;
          reviewer.data = result;
        } else {
          result = await request("/api/track/message", { ...payload, code: tracking.code });
          if (version !== pageVersion) return;
          tracking.data = result;
        }
        success = "Message sent.";
        focus = "#case-message";
        break;
      }
    }
    const unsentMessage = form.id === "status-form" ? document.getElementById("case-message")?.value : "";
    draw();
    const messageField = document.getElementById("case-message");
    if (unsentMessage && messageField) messageField.value = unsentMessage;
    if (focus === "h1") focusPage();
    else document.querySelector(focus)?.focus({ preventScroll: true });
    announce(success);
  } catch (error) {
    if (version !== pageVersion) return;
    for (const control of disabledDuringSubmit) control.disabled = false;
    if (error.status === 401 && route.startsWith("/reviewer") && form.id !== "login-form") return refreshReviewer();
    if (form.id === "report-form" && ["category", "summary", "description", "occurredOn", "location", "privacy", "email"].includes(error.field)) {
      nextStep(["privacy", "email"].includes(error.field) ? 2 : 1);
      showError(errorId, error, document.getElementById("report-form"));
    } else {
      showError(errorId, error, form);
    }
  } finally {
    for (const control of disabledDuringSubmit) control.disabled = false;
    setBusy(button, false);
  }
});

window.addEventListener("hashchange", () => openRoute(currentRoute()));
openRoute(currentRoute(), true);
