/** Verify holds a frozen check to its configured landing.timeout ceiling [C7,V18]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe } from 'node:test';
import { test } from 'node:test';
import { joinFixtureSeat } from "../../tests/fixtures/testkit.js";
import { createE2eHelpers } from "../../tests/fixtures/e2e.js";
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { document } from '../../tests/fixtures/verify/unsealed.js';
import { submitUnsealed } from '../../tests/fixtures/verify/unsealed.js';

// Every case builds its own project and board, so the cases run side by side: the sync setup is short and the frozen checks and verifies dominate.
describe('verify journeys [V4,C7]', { concurrency: true }, () => {
  /**
   * Submit and verify one frozen check whose duration the test sets. The check passes instantly during submit (unarmed),
   * then sleeps delayMs when verify runs it (armed); delayMs of -1 hangs until its ceiling stops it.
   */
  async function frozenCheckCeiling(t, { checkTimeout, landingTimeout, delayMs }) {
    const helpers = createE2eHelpers();
    t.after(helpers.cleanup);
    const box = helpers.project('true');
    const armed = join(box.dir, 'check-armed');
    const script = join(box.dir, 'slow-check.cjs');
    writeFileSync(script, `const fs = require('node:fs');
  const cell = new Int32Array(new SharedArrayBuffer(4));
  if (fs.existsSync(${JSON.stringify(armed)})) {
    const delay = ${delayMs};
    if (delay < 0) for (;;) Atomics.wait(cell, 0, 0, 1000);
    Atomics.wait(cell, 0, 0, delay);
  }
  console.log('TAP version 13\\nok 1 - slow frozen check\\n1..1\\n# tests 1\\n# pass 1\\n# fail 0');
  `);
    const configFile = join(box.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    config.check = { install: '', timeout: checkTimeout };
    config.landing = { timeout: landingTimeout };
    writeFileSync(configFile, JSON.stringify(config, null, 2));
    box.git(box.repo, 'add', 'pullboard.json');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: configure frozen check ceiling');
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    document(await fixtureAdd(box.runIn, box.repo, 'web', 'Verify a slow frozen check', '--criterion', 'the feature builds', '--specs', 'G1', '--check', `node '${script}'`, '--json'));
    document(await box.runIn(box.web, 'claim', '1', '--json'));
    assert.equal(helpers.commitFile(box, box.web, 'web/feature.js', 'built\n', 'feat(web): build feature [G1]').status, 0);
    await submitUnsealed(box);
    const submitted = document(await box.runIn(box.repo, 'show', '1', '--json'));
    const reviewer = join(box.dir, 'reviewer');
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted.item_commit);
    document(joinFixtureSeat(box, reviewer, 'api'));
    writeFileSync(armed, 'armed');
    const result = await box.runIn(reviewer, 'verify', '1', 'accept', '--note', 'Observed the frozen check against its configured ceiling.', '--json');
    return { box, result };
  }

  test('verify runs a frozen check past the check timeout up to the configured landing.timeout [C7,V18]', async t => {
    // A 300ms check.timeout stands in for the default 5m; the 1s check runs past it and inside landing.timeout.
    const { box, result } = await frozenCheckCeiling(t, { checkTimeout: '300ms', landingTimeout: '20s', delayMs: 1000 });
    assert.equal(result.code, 0, result.err || result.out);
    assert.equal(document(await box.runIn(box.repo, 'show', '1', '--json')).item_status, 'verified');
  });

  test('a frozen check that hangs stops at the configured ceiling and names the check and elapsed time [C7,V18]', async t => {
    const { result } = await frozenCheckCeiling(t, { checkTimeout: '300ms', landingTimeout: '1s', delayMs: -1 });
    assert.equal(result.code, 1, result.out);
    const error = JSON.parse(result.out).error;
    assert.equal(error.code, 'CHECK_UNVERIFIED');
    assert.match(error.message, /check timed out after \d+\.\d seconds against its 1\.0 second ceiling/);
    assert.match(error.message, /slow-check\.cjs/);
    assert.match(error.message, /check timed out after [0-9]+\.[0-9] seconds/);
  });
});
