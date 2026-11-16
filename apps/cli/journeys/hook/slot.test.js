/** The commit hooks never queue for a checkout lease or a gate slot, and still refuse a lane violation [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  after,
  test,
} from 'node:test';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { takeResource } from '../../../../packages/resources/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { chargedText } from '../../tests/fixtures/load.js';
import { loadClock } from '../../tests/fixtures/load.js';

const helpers = createE2eHelpers();

/** The #2505 budgets, charged for runner load per core: pre-commit alone 1 s (#6525, #8505); a one-line commit with its hooks 6 s, the audited exception of #8729 (frozen 2 s, restored by #8841). */
const COMMIT_BUDGET_MS = 6000;
const PRE_COMMIT_BUDGET_MS = 1000;
after(helpers.cleanup);

/** Each hook child's wall time from git's trace file, so a slow commit names the hook that spent it. */
function hookSpans(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(line => /\| (?:child_start|child_exit)/u.test(line)).map(line => line.replace(/^.*?\| /u, '').replace(/\s+/gu, ' ').slice(0, 110)).join('; ');
  } catch { return 'no trace'; } finally { rmSync(file, { force: true }); }
}

/** Run one git commit as the session that owns the checkout; return its refusal text and wall time. */
function commitAs(box, cwd, session, path, message) {
  box.env.CODEX_SESSION_ID = session;
  const perf = join(tmpdir(), `slot-trace-${process.pid}-${Date.now()}.txt`);
  box.env.GIT_TRACE2_PERF = perf;
  try {
    const stop = loadClock();
    const result = helpers.commitFile(box, cwd, path, `${path}\n`, message);
    const time = stop();
    return { status: result.status, text: `${result.stderr ?? ''}${result.stdout ?? ''}`, time, hooks: hookSpans(perf) };
  } finally { delete box.env.CODEX_SESSION_ID; delete box.env.GIT_TRACE2_PERF; }
}

test('clause 1; clause 2; clause 3: with every local slot held, a one-line commit passes its hooks without queueing and a lane violation is refused [C7]', { timeout: 60_000 }, async t => {
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
    t.diagnostic(`commit ${chargedText(ok.time)} [${ok.hooks}]; pre-commit ${chargedText(hook)}`);
    // Both budgets charge runner load per core like the file budgets (#6525), so each number is the work the case itself costs.
    assert.ok(ok.time.ms < COMMIT_BUDGET_MS && hook.ms < PRE_COMMIT_BUDGET_MS, // budget: 6 s for the commit (audited exception, #8729; the frozen 2 s moves to #8841) and the frozen 1 s for pre-commit.
      `the commit with its hooks took ${chargedText(ok.time)} [${ok.hooks}] and pre-commit ${chargedText(hook)} with every slot held`);
    const refused = commitAs(box, box.web, session, 'api/other.js', 'feat(web): outside the lane [G1]');
    assert.notEqual(refused.status, 0, 'a lane violation is still refused');
    assert.match(refused.text, /lane/iu);
  } finally {
    for (const hold of holds) hold.release();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
