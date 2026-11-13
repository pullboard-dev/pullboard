/** The board reports runner capacity from pulled jobs: claimed jobs per serve against each serve's jobs setting, with fleet totals [P7,C7,#5993]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { apiHttpFixture } from '../../tests/fixtures/api.js';
import { offerJob } from '../../../../packages/api/index.js';
import { jobQueueCall } from '../../../../packages/api/index.js';

test('two serves claiming 3 of 8 and 1 of 8 pulled jobs report 4 of 16 in runner status --json [P7,C7]', { timeout: 60_000 }, // budget: one private init and one CLI call.
async t => {
  const box = apiHttpFixture(t);
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => db.close());
  for (let n = 0; n < 4; n += 1) offerJob(db, { id: `gate:cap-${n}`, kind: 'gate', needs: [], candidate: 'c'.repeat(40), run: ['node', 'check.js'] });
  // Each serve claims through the board's queue call and names its jobs setting, as `runner serve --jobs 8` does.
  const claim = (runner) => jobQueueCall(db, { action: 'claim', runner, capabilities: [], jobs: 8 }, { mode: 'pull' });
  for (const runner of ['serve-a', 'serve-a', 'serve-a', 'serve-b']) assert.ok(claim(runner).claim, `${runner} holds a job`);
  const ran = await runCliInProcess(['runner', 'status', '--json'], { cwd: box.root, env: box.env });
  assert.equal(ran.status, 0, ran.stderr);
  const status = JSON.parse(ran.stdout);
  assert.deepEqual(status.serves, [{ runner: 'serve-a', claimed: 3, jobs: 8 }, { runner: 'serve-b', claimed: 1, jobs: 8 }]);
  assert.deepEqual(status.totals, { claimed: 4, jobs: 16, serves: 2 });
});
