/** A pulled gate red only on missing main receipts settles when the queued main-test job records, with no resubmit [C7,P7]. */
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
/** Main's test files: "main case" fails in each; "other case" passes on main. */
const MAIN = {
  'web/main.test.js': "import { test } from 'node:test';\ntest('main case', () => { throw new Error('main'); });\n",
  'web/mixed.test.js': "import { test } from 'node:test';\ntest('main case', () => { throw new Error('main'); });\ntest('other case', () => {});\n",
};

/** The text of every fact on an item's thread. */
function facts(board, id) {
  return itemThread(board, id).filter(entry => entry.type === 'fact').map(entry => entry.text ?? entry.fact?.text ?? '').join('\n');
}

test('clause 1: a gate red only on cases missing a main receipt turns green, with no resubmit, once the queued main-test job records them failing on that main; a case main passes leaves it red as new [C7]', { timeout: 300_000 }, // budget: hang ceiling for a project, two submits, two gates and two main-test jobs in runner processes.
async t => {
  provideMainTestRecorder(recordMainTestReceipt);
  t.after(() => provideMainTestRecorder(null));
  const check = n => `env -u NODE_TEST_CONTEXT node --test --test-reporter=tap ${n === 1 ? 'web/main.test.js' : 'web/mixed.test.js'}`;
  const box = await pullProject(t, 2, { check });
  for (const [path, text] of Object.entries({ ...MAIN, 'packages/gate/light.js': `export { tapFailures } from ${JSON.stringify(LIGHT)};\n` })) {
    mkdirSync(dirname(join(box.repo, path)), { recursive: true });
    writeFileSync(join(box.repo, path), text);
  }
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), affectedTests: 'node --test --test-reporter=tap' }, null, 2) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: main red cases [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');

  const [mainOnly, broken] = box.ids;
  const mainSubmit = submitOne(box, mainOnly);
  // The second item makes main's passing case fail: that case is new.
  submitOne(box, broken, { path: 'web/mixed.test.js', body: MAIN['web/mixed.test.js'].replace("test('other case', () => {});", "test('other case', () => { throw new Error('new'); });"), subject: 'feat(web): break other case [G1]' });
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo, compareWithMain: criterionMainReceipts }) });
  for (const runner of ['r-gate-1', 'r-gate-2']) assert.equal((await serveOnce(box, url, runner)).code, 0);

  // No main receipt yet: both gates are red only on missing receipts and wait on queued main-test jobs.
  for (const id of box.ids) {
    assert.equal(getItem(board, id).item_status, 'claimed', facts(board, id));
    assert.match(facts(board, id), /main receipt missing: check web\/m\w+\.test\.js \(main case\)/u);
  }
  const queued = jobsOf(board.db, { kind: 'main-test' });
  assert.equal(queued.length, 2, JSON.stringify(queued.map(job => [job.id, job.step])));
  const gates = box.ids.map(id => jobsOf(board.db, { kind: 'gate', item: id }).length);

  for (const runner of ['r-main-1', 'r-main-2']) assert.equal((await serveOnce(box, url, runner)).code, 0);
  assert.deepEqual(jobsOf(board.db, { kind: 'main-test' }).map(job => job.step), ['done', 'done'], 'both main-test jobs recorded');

  const passed = getItem(board, mainOnly);
  assert.deepEqual([passed.item_status, passed.item_commit], ['submitted', mainSubmit.commit], `red only in main's case settles to review: ${facts(board, mainOnly)}`);
  assert.match(facts(board, mainOnly), /also fails on main: check web\/main\.test\.js \(main case\)/u);
  assert.equal(getItem(board, broken).item_status, 'claimed', 'a case main passes keeps the item with its builder');
  assert.match(facts(board, broken), /new: check web\/mixed\.test\.js \(other case\)/u);
  assert.deepEqual(box.ids.map(id => jobsOf(board.db, { kind: 'gate', item: id }).length), gates, 'no resubmit: no new gate job was offered');
});

test('clause 1 and 2: a file unchanged on a later main answers from that main\'s receipt and queues no job; a case it passes is new; a changed file stays unknown [C7]', { timeout: 120_000 }, // budget: one project and one queue in this process, no runner.
async t => {
  const box = await pullProject(t, 1, { check: () => 'true' });
  for (const [path, text] of Object.entries({ ...MAIN, 'web/third.test.js': MAIN['web/mixed.test.js'], 'other.txt': '1\n' })) {
    mkdirSync(dirname(join(box.repo, path)), { recursive: true });
    writeFileSync(join(box.repo, path), text);
  }
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), affectedTests: 'node --test --test-reporter=tap' }, null, 2) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: main red cases [G1]');
  const first = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  // Main moves: an unrelated file changes, then main-mixed.test.js changes.
  writeFileSync(join(box.repo, 'other.txt'), '2\n');
  box.git(box.repo, 'commit', '-q', '-am', 'chore: unrelated [G1]');
  const later = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(box.repo, 'web/mixed.test.js'), `${MAIN['web/mixed.test.js']}// edited\n`);
  box.git(box.repo, 'commit', '-q', '-am', 'test: edit mixed [G1]');
  const { board } = await pullQueue(t, box, {});
  recordMainTestReceipt(box.repo, { main: later, file: 'web/main.test.js', verdict: 'red', job: 'job-later' });
  recordMainTestReceipt(box.repo, { main: later, file: 'web/mixed.test.js', verdict: 'red', job: 'job-later-2' });
  recordMainTestReceipt(box.repo, { main: later, file: 'web/third.test.js', verdict: 'green', job: 'job-later-3' });
  const ask = cases => criterionMainReceipts({ root: box.repo, db: board.db, main: first, cases });
  const same = ask([{ file: 'web/main.test.js', name: 'main case' }]);
  assert.notEqual(same.classes[0].owner, 'unknown', JSON.stringify(same.classes));
  assert.equal(same.classes[0].receipt, 'job-later');
  assert.deepEqual(same.jobs, [], 'a nearby receipt queues no main-test job');
  assert.equal(jobsOf(board.db, { kind: 'main-test' }).length, 0);
  // A case that passes on that main stays new.
  const passes = ask([{ file: 'web/third.test.js', name: 'main case' }]);
  assert.deepEqual([passes.classes[0].owner, passes.classes[0].own], ['candidate', ['main case']], JSON.stringify(passes.classes));
  // A file changed between the two mains has no receipt for this main's content.
  const changed = ask([{ file: 'web/mixed.test.js', name: 'main case' }]);
  assert.equal(changed.classes[0].owner, 'unknown', JSON.stringify(changed.classes));
  assert.equal(jobsOf(board.db, { kind: 'main-test' }).length, 1, 'the changed file queues its own main-test job');
});
