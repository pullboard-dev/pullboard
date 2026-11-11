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

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Run one git commit as the session that owns the checkout; return its refusal text and wall time. */
function commitAs(box, cwd, session, path, message) {
  box.env.CODEX_SESSION_ID = session;
  try {
    const started = performance.now();
    const result = helpers.commitFile(box, cwd, path, `${path}\n`, message);
    return { status: result.status, text: `${result.stderr ?? ''}${result.stdout ?? ''}`, ms: performance.now() - started };
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
    assert.ok(ok.ms < 2000, `the commit with its hooks took ${Math.round(ok.ms)} ms with every slot held`); // budget: frozen #2505 clause 3 permits under 2 s.
    const started = performance.now();
    const direct = box.run(box.web, 'hook', 'pre-commit');
    const hookMs = performance.now() - started;
    assert.equal(direct.code, 0, direct.err);
    assert.ok(hookMs < 1000, `pre-commit took ${Math.round(hookMs)} ms with every slot held`); // budget: measured below 1 s in fact 6b669f62; retain the frozen #2505 ceiling.
    const refused = commitAs(box, box.web, session, 'api/other.js', 'feat(web): outside the lane [G1]');
    assert.notEqual(refused.status, 0, 'a lane violation is still refused');
    assert.match(refused.text, /lane/iu);
  } finally {
    for (const hold of holds) hold.release();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
