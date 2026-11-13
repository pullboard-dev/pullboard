/** The runner round trip deadline resets per attempt, and a permanently held result return stays a named bounded failure [C7]. */
/** Scenario partition: the five loaded paired reruns each run in deadlines/rerun/ so every file stays under its budget. */
import { after } from 'node:test';
import { test } from 'node:test';
import { PAIRED_RERUN_FIXTURE } from '../../../tests/fixtures/runner/paired/tools.js';
import { assertAttemptDeadlineReset } from '../../../tests/fixtures/runner/paired/rerun.js';
import { assertRedispatchDeadlineAccounting } from '../../../tests/fixtures/runner/paired/rerun.js';
import { runPairedRerun } from '../../../tests/fixtures/runner/paired/rerun.js';
import { assertFixtureGroupEpermControls } from '../../../tests/fixtures/runner/group.js';
import { cleanupFixtureChildren } from '../../../tests/fixtures/child.js';
import { cleanupToolingSnapshots } from '../../../tests/fixtures/runner/tooling.js';

after(cleanupFixtureChildren);
after(cleanupToolingSnapshots);

test('the runner round trip deadline resets per attempt and still catches a stuck phase [C7]',
  { timeout: 120_000 }, async t => { // budget: two deadline accountings and one bounded held phase, below the file hang ceiling.
    await assertAttemptDeadlineReset(PAIRED_RERUN_FIXTURE);
    await assertRedispatchDeadlineAccounting(PAIRED_RERUN_FIXTURE);
    assertFixtureGroupEpermControls();
    await t.test('a permanently held result return remains a named bounded failure [C7]', { skip: 'CONTROLLER_ONLY: deleted with #7526' }, async child => {
      await runPairedRerun(child, 'paired-no-load', PAIRED_RERUN_FIXTURE, { hold: 'return' });
    });
  });
