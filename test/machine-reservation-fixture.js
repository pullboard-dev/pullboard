/** Declaration assertions shared with the bounded machine test file [V15,M1]. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Preserve the lifecycle and help controls when the guarded reservation declaration grows. */
export function assertLifecycleReservation(machineRules, HELP) {
  const page = machineRules.lifecycleMarkdown();
  assert.match(page, /^\| reserve \| submitted \| submitted \| agent, coordinator \| .*reviewFree \(REVIEW_HELD\), result \(BAD_DEPENDENCIES\) \|$/m);
  for (const verb of ['accept', 'reject']) assert.match(page, new RegExp(`^\\| ${verb} \\| submitted, verified \\| .*policyAllows \\(COORDINATOR_VERIFIES\\), requiredReviewFamily \\(REQUIRED_REVIEW_FAMILY\\), familyAllows \\(O2_FAMILY_MATCH or LINE_SETTING_RANGE\\), reviewFree \\(REVIEW_HELD\\), criterionUnchanged`, 'm'));
  assert.match(page, /^\| REVIEW_HELD \| no other agent holds its review under a live lease \| pullboard next --verify/m);
  assert.match(HELP.all, /^ {2}agent +rehomeImport, intake, claim, release, submit, reserve, accept, reject, reopen, escalate, submit-merge \(when only an unchanged accepted bar and a proved trunk-only merge; no new reviewer verdict is created\), refreeze \(when a live claim has a pending coordinator correction or a validated cited-spec correction\)$/m);
  assert.match(HELP.all, /pullboard next --verify +reserve the next submitted item you can check/);
}

/** Exercise configured review lease durations using an actual private settings file. */
export function assertConfiguredReviewLease(loadConfig) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'pullboard-review-lease-'));
  try {
    const leaseOf = (config) => {
      fs.writeFileSync(join(dir, 'pullboard.json'), JSON.stringify({ gate: 'true', ...config }));
      return loadConfig(dir).reviewLeaseMs;
    };
    assert.equal(leaseOf({}), 30 * 60_000);
    assert.equal(leaseOf({ reviewLease: '2h' }), 2 * 3_600_000);
    assert.throws(() => leaseOf({ reviewLease: 'soon' }), { code: 'BAD_CONFIG', message: /reviewLease "soon" is not a duration/ });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
