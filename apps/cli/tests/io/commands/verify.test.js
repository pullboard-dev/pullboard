/** @pullboard-test-input apps/cli/src/io/commands/verify.js */
/** A strict item's accept states what the reviewer broke: refused without --broke, recorded with it, and unchanged for reject and for items that do not require it [C7,#12047]. */
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { provenBreakStatement } from '../../../src/io/commands/verify.js';
import { fixtureProjectPolicy } from '../../fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const BROKE = 'ran node --test on the changed file with the guard removed and the case failed';

/** A submitted item on a board whose review.requireProvenBreak is set as named, or left unset. */
function submitted(requireProvenBreak) {
  const box = e2e.privateCheckSubmission({ check: 'true' });
  if (requireProvenBreak !== undefined) {
    const config = { ...JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')), review: { requireProvenBreak } };
    fixtureProjectPolicy(box.repo, { config });
    box.git(box.repo, 'add', 'pullboard.json');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: set review.requireProvenBreak');
    // The reviewing seat reads the board policy from its own checkout.
    copyFileSync(join(box.repo, 'pullboard.json'), join(box.review, 'pullboard.json'));
  }
  return box;
}

test('cli.io-commands-verify.strict-accept-needs-break: clause 1: on a strict item verify accept without --broke is refused PROVEN_BREAK_REQUIRED with the flag in its next line and records nothing, with a 40-character --broke it accepts and the statement is on the item thread [C7,#12047]', async () => {
  for (const broke of [undefined, '', 'too short']) {
    assert.throws(() => provenBreakStatement(true, broke), error => error.code === 'PROVEN_BREAK_REQUIRED' && /--broke/u.test(error.message) && /nothing was recorded/u.test(error.message));
  }
  assert.equal(provenBreakStatement(true, BROKE), BROKE);
  assert.equal(provenBreakStatement(false, undefined), '');
  const box = submitted(undefined);
  const accepted = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'read the diff against the bar', '--broke', BROKE, '--json');
  assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
  const shown = await box.runLocal(box.review, 'show', '1', '--detail');
  assert.match(shown.stdout, new RegExp(`proven break: ${BROKE}`, 'u'));
});

test('cli.io-commands-verify.strict-reject-unchanged: clause 1: a reject on an item whose review requires a proven break needs no --broke [C7,#12047]', async () => {
  const box = submitted(true);
  const rejected = await box.runLocal(box.review, 'verify', '1', 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', 'The page renders.', '--note', 'the diff skips the bar clause', '--json');
  assert.doesNotMatch(rejected.stdout + rejected.stderr, /PROVEN_BREAK_REQUIRED/u);
  assert.equal(rejected.code, 0, rejected.stdout + rejected.stderr);
});

test('cli.io-commands-verify.steady-accept-unchanged: clause 1: a steady item with the setting unset accepts without --broke [C7,#12047]', async () => {
  const box = submitted(undefined);
  const accepted = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'read the diff against the bar', '--json');
  assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
});
