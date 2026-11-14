/** Two pulled submits red on the same main case share one main-test job; neither waits on the other's job [V4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { provideMainTestRecorder } from '../../../../packages/api/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { recordMainTestReceipt } from '../../../../packages/landing/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { itemThread } from '../../../../packages/store/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';
import { criterionMainReceipts } from '../../src/io/submit/receipt.js';

const LIGHT = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/gate/light.js')).href;
/** Main's two test files, each failing one case on main (the fixture's inherited red). */
const MAIN = Object.fromEntries(['a', 'b'].map(name => [`web/${name}.test.js`,
  `import { test } from 'node:test';\ntest('${name} actual inherited assertion [G1]', () => { throw new Error('${name}'); });\n`]));

/** The text of every fact on an item's thread. */
function facts(board, id) {
  return itemThread(board, id).filter(entry => entry.type === 'fact').map(entry => entry.text ?? entry.fact?.text ?? '').join('\n');
}

// Since submit is pulled it returns at once; the held in-process comparison this case once raced no longer exists, so it
// pins the same promise on the queue: the second submit's gate settles on its own, and the main comparison of a case both
// items inherit is one queued job, not one per submit.
test('a second submit settles its gate while the first main-test job is unserved, and a case both inherit queues one main-test job [V4,C7]', { timeout: 300_000 }, // budget: hang ceiling for a project, two submits, two gates and two main-test jobs in runner processes.
async t => {
  provideMainTestRecorder(recordMainTestReceipt);
  t.after(() => provideMainTestRecorder(null));
  const tap = files => `env -u NODE_TEST_CONTEXT node --test --test-reporter=tap ${files.join(' ')}`;
  const box = await pullProject(t, 2, { check: n => tap(n === 1 ? ['web/a.test.js', 'web/b.test.js'] : ['web/b.test.js']) });
  for (const [path, text] of Object.entries({ ...MAIN, 'packages/gate/light.js': `export { tapFailures } from ${JSON.stringify(LIGHT)};\n` })) {
    mkdirSync(dirname(join(box.repo, path)), { recursive: true });
    writeFileSync(join(box.repo, path), text);
  }
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), affectedTests: 'node --test --test-reporter=tap' }, null, 2) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: main red cases [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');

  const [first, second] = box.ids;
  const firstSubmit = submitOne(box, first);
  const secondSubmit = submitOne(box, second);
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo, compareWithMain: criterionMainReceipts }) });
  for (const runner of ['r-gate-1', 'r-gate-2']) assert.equal((await serveOnce(box, url, runner)).code, 0);

  // Both gates are red only on missing main receipts; no main-test job has been served, yet neither item waits on the other.
  for (const id of box.ids) assert.equal(getItem(board, id).item_status, 'claimed', facts(board, id));
  const queued = jobsOf(board.db, { kind: 'main-test' });
  assert.ok(queued.every(job => job.step !== 'done'), 'no main-test job has been served');
  assert.equal(queued.length, 2, 'one main-test job per distinct file (a once, b once), not one per submit: ' + JSON.stringify(queued.map(job => [job.id, job.step])));

  for (const runner of ['r-main-1', 'r-main-2', 'r-main-3']) assert.equal((await serveOnce(box, url, runner)).code, 0);
  assert.ok(jobsOf(board.db, { kind: 'main-test' }).every(job => job.step === 'done'), 'every main-test job recorded: ' + JSON.stringify(jobsOf(board.db, { kind: 'main-test' }).map(job => [job.id.slice(-40), job.step])));
  for (const [id, submit] of [[first, firstSubmit], [second, secondSubmit]]) {
    const settled = getItem(board, id);
    assert.deepEqual([settled.item_status, settled.item_commit], ['submitted', submit.commit], `red only on inherited main failures settles to review: ${facts(board, id)}`);
    assert.match(facts(board, id), /also fails on main: check web\/b\.test\.js \(b actual inherited assertion/u);
  }
  assert.match(facts(board, first), /also fails on main: check web\/a\.test\.js \(a actual inherited assertion/u);
});
