/** Each runner claim records the serve's jobs setting, cores and RAM, and pullboard stats runners --json reports them per serve [C7,#6135]. */
import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { apiHttpFixture } from '../../../tests/fixtures/api.js';
import { runCliInProcess } from '../../../tests/fixtures/process.js';
import { jobQueueCall } from '../../../../../packages/api/index.js';
import { offerJob } from '../../../../../packages/api/index.js';
import { serveRunner } from '../../../../../packages/drive/index.js';

test('a serve claim carries jobs, cores and RAM in its claimed step and stats runners --json reports them per serve [C7,#6135]', { timeout: 60_000 }, // budget: one private init, one claim and one CLI call.
async t => {
  const box = apiHttpFixture(t);
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => db.close());
  offerJob(db, { id: 'gate:cap-a', kind: 'gate', needs: [], candidate: 'c'.repeat(40), run: ['node', 'check.js'] });
  offerJob(db, { id: 'gate:cap-b', kind: 'gate', needs: [], candidate: 'd'.repeat(40), run: ['node', 'check.js'] });
  // The real serve makes its claim call; the board records it and the serve is told the queue is empty, so it stops without running anything.
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/trunk') || String(url).includes('/trunk/')) return new Response('{}', { status: 404 });
    const body = JSON.parse(init.body);
    bodies.push(body);
    jobQueueCall(db, body, { mode: 'pull' });
    return new Response(JSON.stringify({ claim: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await serveRunner({ board: `${box.origin}${box.path}?k=${box.key}`, runner: 'serve-a', capabilities: [], cache: join(box.dir ?? box.root, 'cache-a'), once: true, fetchImpl, timing: { idleMs: 10 }, trunkPack: async () => null });
  assert.equal(bodies.length, 1);
  assert.deepEqual([bodies[0].jobs, bodies[0].cores, bodies[0].ram], [1, availableParallelism(), totalmem()]);
  // A second serve on a smaller runner claims through the queue call with its own figures.
  assert.ok(jobQueueCall(db, { action: 'claim', runner: 'serve-b', capabilities: [], jobs: 2, cores: 4, ram: 8_589_934_592 }, { mode: 'pull' }).claim);
  const step = db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_name = 'claimed' ORDER BY job_step_at DESC, job_step_id DESC LIMIT 1").get();
  assert.deepEqual(['jobs', 'cores', 'ram'].map(key => JSON.parse(step.payload)[key]), [2, 4, 8_589_934_592]);
  const ran = await runCliInProcess(['stats', 'runners', '--json'], { cwd: box.root, env: box.env });
  assert.equal(ran.status, 0, ran.stderr);
  const { serves } = JSON.parse(ran.stdout).runners;
  assert.deepEqual(serves.find(row => row.runner === 'serve-b'), { runner: 'serve-b', claims: 1, jobs: 2, cores: 4, ram: 8_589_934_592 });
});
