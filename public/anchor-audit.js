const numbers = new Intl.NumberFormat("en-GB");
const dates = new Intl.DateTimeFormat("en-GB", {
  year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset",
});

export function auditTime(value) {
  const date = new Date(value);
  return `<time datetime="${date.toISOString()}">${dates.format(date)}</time>`;
}

function range(first, last) {
  return first === last ? `entry ${numbers.format(first)}` : `entries ${numbers.format(first)}–${numbers.format(last)}`;
}

function verifiedSection(verified, tenantPrefix) {
  if (!verified) return "";
  const base = tenantPrefix + "/api/admin/anchoring/" + verified.entries;
  const name = tenantPrefix.split("/").at(-1) + "-auto-" + verified.entries + ".json";
  return `<section class="audit-record" aria-label="Verified checkpoint">
    <h3>Verified checkpoint</h3>
    <dl class="audit-facts">
      <div><dt>History covered</dt><dd class="audit-range">${range(1, verified.entries)}</dd></div>
      <div><dt>Bitcoin block</dt><dd>${verified.block}</dd></div>
      <div><dt>Verified by the platform</dt><dd>${auditTime(verified.at)}</dd></div>
    </dl>
    <p class="audit-note">A checkpoint is a digital fingerprint of the recorded history. The Bitcoin proof shows that fingerprint existed by this block. Changing a covered entry would break the match. Reviewers assess the reports separately.</p>
    <div class="audit-files"><span>Matching proof files</span>
      <a class="text-link" href="${base}/checkpoint" download>Checkpoint (.json)</a>
      <a class="text-link" href="${base}/receipt" download>Bitcoin receipt (.ots)</a></div>
    <p class="audit-print-only audit-note">Matching proof files<br><code>${name}</code><br><code>${name}.ots</code></p>
  </section>`;
}

const phases = {
  queued: ["Preparing for submission", "The service is preparing the checkpoint for OpenTimestamps."],
  pending: ["Awaiting Bitcoin confirmation", "OpenTimestamps has issued a receipt. The service checks automatically for a Bitcoin proof."],
  verifying: ["Checking the Bitcoin proof", "The service is checking the returned proof against Bitcoin and the recorded history."],
};

function openCheckpoint(anchor) {
  const { verified, entries, phase, state } = anchor;
  if (!entries || phase === "verified") return "";
  const [label, explanation] = phases[phase];
  const added = entries - (verified?.entries ?? 0);
  const coverage = verified
    ? `It includes ${numbers.format(added)} new ${added === 1 ? "entry" : "entries"} beyond the verified proof (${range(verified.entries + 1, entries)}).`
    : "The organisation has no verified Bitcoin proof yet.";
  const retry = state === "retrying";
  const next = anchor.retryAt && state !== "check_failed"
    ? `<p class="audit-timing">Next scheduled attempt from ${auditTime(anchor.retryAt)}</p>` : "";
  return `<section class="audit-record" aria-label="Checkpoint in progress">
    <div class="audit-row-heading"><h3>${verified ? "Newer checkpoint" : "Checkpoint in progress"}</h3>
      <span class="status status--${retry ? "reviewing" : "received"}">${retry ? "Retry scheduled" : label}</span></div>
    <p class="audit-note">This checkpoint covers ${range(1, entries)}. ${coverage}</p>
    <p class="audit-note">${retry ? ({queued: "Submission did not complete.", pending: "The receipt check did not complete.", verifying: "The proof check did not complete."}[phase]) : explanation}</p>
    ${next}
  </section>`;
}

export function anchorAudit(anchor, tenantPrefix) {
  const { verified, entries, state } = anchor;
  const count = verified?.entries ?? 0;
  const summary = entries
    ? `${numbers.format(count)} of ${numbers.format(entries)} ${entries === 1 ? "entry" : "entries"} verified`
    : "No checkpoint recorded";
  const checked = state === "check_failed";
  return `<div class="audit-summary">
    <p class="audit-lead">${checked ? "History check needs attention" : summary}</p>
    <p class="audit-note">${checked
      ? "The latest history check failed. Previously verified results are shown as recorded. The platform operator should review this failure."
      : entries ? "Coverage of the latest checkpoint. Each entry records a submission, message or status change."
      : "The service creates a checkpoint when it finds the first case history entries for this organisation."}</p>
  </div>
  ${verifiedSection(verified, tenantPrefix)}
  ${openCheckpoint(anchor)}
  ${checked && anchor.checkedAt ? `<p class="audit-timing">History check attempted ${auditTime(anchor.checkedAt)}</p>` : ""}`;
}
