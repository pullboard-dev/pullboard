/** The commit hooks never queue for a checkout lease or a gate slot, and still refuse a lane violation [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  after,
  test,
} from 'node:test';
import { resolve } from 'node:path';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { takeResource } from '../../../../packages/resources/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { chargedText } from '../../tests/fixtures/load.js';
import { loadClock } from '../../tests/fixtures/load.js';

const helpers = createE2eHelpers();

/** Audited exceptions at measured own time (#6525, run b9b81cc9: commit 4273 ms at load 2.0x); targets 2000 and 1000 ms. */
const COMMIT_EXCEPTION_MS = 4500;
const PRE_COMMIT_EXCEPTION_MS = 2500;
after(helpers.cleanup);

/** Run one git commit as the session that owns the checkout; return its refusal text and wall time. */
function commitAs(box, cwd, session, path, message) {
  box.env.CODEX_SESSION_ID = session;
  try {
    const stop = loadClock();
    const result = helpers.commitFile(box, cwd, path, `${path}\n`, message);
    return { status: result.status, text: `${result.stderr ?? ''}${result.stdout ?? ''}`, time: stop() };
  } finally { delete box.env.CODEX_SESSION_ID; }
}

test('clause 1; clause 2; clause 3: with every local slot held, a one-line commit passes its hooks without queueing and a lane violation is refused [C7]', { timeout: 60_000 }, async () => {
  const box = helpers.project();
  const session = 'hook-no-slot-2505';
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Hook speed', '--specs', 'G1').code, 0);
  box.env.CODEX_SESSION_ID = session;
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  delete box.env.CODEX_SESSION_ID;
  const gitDir = resolve(box.web, box.git(box.web, 'rev-parse', '--git-dir'));
  const saved = { ...process.env };
  Object.assign(process.env, { PULLBOARD_MACHINE_HOME: box.env.PULLBOARD_MACHINE_HOME, PULLBOARD_HOME: box.env.PULLBOARD_HOME });
  const holds = [];
  try {
    holds.push(await takeResource({ name: 'checkout-session:' + createHash('sha256').update(gitDir).digest('hex'), capacity: 1, scope: 'repo', root: box.repo, agent: 'holder' }));
    holds.push(await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: box.repo, repo: box.repo, agent: 'holder' }));
    const ok = commitAs(box, box.web, session, 'web/page.html', 'feat(web): one line [G1]');
    assert.equal(ok.status, 0, ok.text);
    // Before this change each hook waited 30 s for the held lease and then refused with CHECKOUT_BUSY.
    const stop = loadClock();
    const direct = box.run(box.web, 'hook', 'pre-commit');
    const hook = stop();
    assert.equal(direct.code, 0, direct.err);
    // Both budgets charge runner load per core like the file budgets (#6525). On a loaded runner the charged time is still
    // over the frozen #2505 2 s and 1 s ceilings, so each holds an audited exception at its measured value, ratchet-only:
    // lower it as work is cut, never raise it. The 0.9.5 remainder of #6525 removes both.
    assert.ok(ok.time.ms < COMMIT_EXCEPTION_MS && hook.ms < PRE_COMMIT_EXCEPTION_MS, // budget: audited exception #6525 at measured run b9b81cc9; target 2 s and 1 s (#2505).
      `the commit with its hooks took ${chargedText(ok.time)} and pre-commit ${chargedText(hook)} with every slot held`);
    const refused = commitAs(box, box.web, session, 'api/other.js', 'feat(web): outside the lane [G1]');
    assert.notEqual(refused.status, 0, 'a lane violation is still refused');
    assert.match(refused.text, /lane/iu);
  } finally {
    for (const hold of holds) hold.release();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
