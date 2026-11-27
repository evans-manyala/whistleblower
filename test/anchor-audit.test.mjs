import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorAudit } from "../public/anchor-audit.js";

const proof = { entries: 2, block: 977766, at: Date.UTC(2026, 10, 27, 7, 7) };
const render = (state, phase, entries, verified = null) => anchorAudit({
  state, phase, entries, verified, checkedAt: proof.at, retryAt: proof.at + 900000,
}, "/o/example");

test("audit view assigns proof files and block only to the verified prefix", () => {
  const pending = render("pending", "pending", 5, proof);
  assert.match(pending, /2 of 5 entries verified/);
  assert.match(pending, /3 new entries beyond the verified proof \(entries 3–5\)/);
  assert.match(pending, /This checkpoint covers entries 1–5/);
  assert.match(pending, /\/o\/example\/api\/admin\/anchoring\/2\/receipt/);
  assert.doesNotMatch(pending, /anchoring\/5\//);
  const complete = render("verified", "verified", 5, { ...proof, entries: 5 });
  assert.match(complete, /5 of 5 entries verified/);
  assert.match(complete, /anchoring\/5\/receipt/);
  assert.doesNotMatch(complete, /Newer checkpoint|Awaiting Bitcoin confirmation/);
});

test("audit view distinguishes a pending first receipt, an empty history and verification failures", () => {
  assert.match(render("waiting", null, null), /No checkpoint recorded/);
  for (const phase of ["queued", "pending", "verifying"]) {
    const first = render(phase, phase, 1);
    assert.match(first, /0 of 1 entry verified/);
    assert.doesNotMatch(first, /href=|Bitcoin block<|Verified checkpoint/);
    assert.match(render("retrying", phase, 3, proof), /Retry scheduled/);
  }
  const single = render("pending", "pending", 3, proof);
  assert.match(single, /1 new entry beyond the verified proof \(entry 3\)/);
  const failed = render("check_failed", "verified", 2, proof);
  assert.match(failed, /History check needs attention/);
  assert.match(failed, /977766/);
  assert.doesNotMatch(failed, /2 of 2 entries verified|Newer checkpoint/);
});
