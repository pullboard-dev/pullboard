/** A runner keeps its job lease across a board API restart, and a slow Git read never drops the project [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apiHttpBox } from '../../tests/fixtures/api.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { jobView } from '../../../../packages/jobs/index.js';
import { offerJob } from '../../../../packages/api/index.js';
import { serveRunner } from '../../../../packages/drive/index.js';
import { realGitAdapter } from '../../../../packages/git/src/io/adapter.js';
import { withGitAdapter } from '../../../../packages/git/src/io/adapter.js';
import { withProjectGitTimeout } from '../../../../packages/git/src/io/adapter.js';
import { gitSpawnSync } from '../../../../packages/git/src/io/adapter.js';
import { PROJECT_GIT_ATTEMPTS } from '../../../../packages/git/src/io/adapter.js';

test('clause 1: a slow Git read during project registration retries instead of skipping the project [C7]', { timeout: 30_000 }, // budget: two stubbed timeouts then one real git call.
() => {
  const cwd = process.cwd();
  let timeouts = 2;
  const slow = { ...realGitAdapter, spawnSync: (args, options) => (timeouts-- > 0 ? { status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) } : realGitAdapter.spawnSync(args, options)) };
  const result = withGitAdapter(slow, () => withProjectGitTimeout(cwd, () => gitSpawnSync(['--version'], { cwd, encoding: 'utf8' })));
  assert.equal(result.status, 0, 'the third try answers, so the project is kept');
  // A repo that never answers is still skipped, after every try.
  let calls = 0;
  const dead = { ...realGitAdapter, spawnSync: () => { calls += 1; return { status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }; } };
  assert.throws(() => withGitAdapter(dead, () => withProjectGitTimeout(cwd, () => gitSpawnSync(['--version'], { cwd }))), { code: 'BOARD_UNAVAILABLE' });
  assert.equal(calls, PROJECT_GIT_ATTEMPTS);
});

test('clause 2: a runner whose renewals fail during an API gap keeps its lease and its job is not re-claimed [C7]', { timeout: 60_000 }, // budget: a 1.5 s job with a 0.8 s board gap.
async (t) => {
  const box = await apiHttpBox(t);
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'pull' } });
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => db.close());
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: box.root, env: box.env, encoding: 'utf8' }).trim();
  offerJob(db, { id: 'gate:restart', kind: 'gate', needs: [], candidate: head, run: [process.execPath, '-e', 'setTimeout(() => {}, 1500)'] });
  const gapEnds = Date.now() + 2_300;
  let gap = false, renews = 0;
  // From the first renewal, the board answers an unreachable error, then a non-lease refusal, for the rest of the gap.
  const fetchImpl = async (url, init) => {
    if (JSON.parse(init.body).action === 'renew') {
      gap ||= true;
      renews += 1;
      if (Date.now() < gapEnds) {
        if (renews % 2) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ error: { code: 'BOARD_UNAVAILABLE', message: 'project skipped' } }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
    }
    return fetch(url, init);
  };
  const lines = [];
  const served = await serveRunner({ board: `${box.origin}${box.path}?k=${box.key}`, runner: 'r-gap', capabilities: [], cache: join(box.dir, 'cache'), once: true, fetchImpl, say: line => lines.push(line),
    timing: { renewMs: 100, renewRetryMs: 50, leaseMs: 60_000, idleMs: 10 } });
  assert.ok(gap && renews >= 4, `renewals kept retrying through the gap (${renews})`);
  assert.deepEqual(served.jobs.map(job => [job.job, job.outcome]), [['gate:restart', 'posted']]);
  assert.ok(!lines.some(line => /lost the lease/u.test(line)), 'the lease was never given up');
  assert.equal(lines.filter(line => /claimed gate:restart/u.test(line)).length, 1, 'the job was claimed once, never re-claimed');
  assert.equal(jobView(db, 'gate:restart').step, 'done');
});
