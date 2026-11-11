/** A pulled gate compares its failing cases with main's receipts: only new failures return the item to its builder [P7]. */
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
import { jobsOf } from '../../../../packages/jobs/index.js';
import { cacheFile } from '../../../../packages/landing/index.js';
import { MAIN_FAILURE_SIGNATURE_VERSION } from '../../../../packages/landing/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { itemThread } from '../../../../packages/store/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';
import { criterionMainReceipts } from '../../src/io/submit/receipt.js';

const LIGHT = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/gate/light.js')).href;
/** A test file whose two cases fail, and one whose only case fails; main's receipts name only "main case" as red. */
const CASES = {
  'web/mixed.test.js': "import { test } from 'node:test';\ntest('main case', () => { throw new Error('main'); });\ntest('new case', () => { throw new Error('new'); });\n",
  'web/main.test.js': "import { test } from 'node:test';\ntest('main case', () => { throw new Error('main'); });\n",
};

/** The text of every fact on an item's thread. */
function facts(board, id) {
  return itemThread(board, id).filter(entry => entry.type === 'fact').map(entry => entry.text ?? entry.fact?.text ?? '').join('\n');
}

test('clause 1: a pulled gate marks each failing case new or also failing on main from main\'s receipts, and only new failures return the item [P7]', { timeout: 240_000 }, // budget: hang ceiling for a project, two submits and two whole gates in runner processes.
async t => {
  // The check runs node --test as its own top-level run, not as a child of this test file's runner.
  const check = n => `env -u NODE_TEST_CONTEXT node --test --test-reporter=tap ${n === 1 ? 'web/mixed.test.js' : 'web/main.test.js'}`;
  const box = await pullProject(t, 2, { check });
  // Main gains the two test files, a test command for its receipts and main's own TAP reader, which the gate job loads from main.
  for (const [path, text] of Object.entries({ ...CASES, 'packages/gate/light.js': `export { tapFailures } from ${JSON.stringify(LIGHT)};\n` })) {
    mkdirSync(dirname(join(box.repo, path)), { recursive: true });
    writeFileSync(join(box.repo, path), text);
  }
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), affectedTests: 'node --test' }, null, 2) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: main red cases [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const main = box.git(box.repo, 'rev-parse', 'main');
  // Main's receipts: each file is red on main in "main case" only.
  const red = file => ({ result: 'red', failures: [{ file, name: 'main case', signature: 'a'.repeat(64) }], signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION, receiptId: `mr-${file}` });
  mkdirSync(dirname(cacheFile(box.repo)), { recursive: true });
  writeFileSync(cacheFile(box.repo), JSON.stringify({ version: 2, entries: { [main]: Object.fromEntries(Object.keys(CASES).map(file => [file, red(file)])) } }), { mode: 0o600 });

  const [mixed, mainOnly] = box.ids;
  const mixedSubmit = submitOne(box, mixed);
  const mainSubmit = submitOne(box, mainOnly);
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo, compareWithMain: criterionMainReceipts }) });
  const builder = getItem(board, mixed).item_owner;
  for (const runner of ['r-one', 'r-two']) assert.equal((await serveOnce(box, url, runner)).code, 0);
  const receiptOf = id => jobsOf(board.db, { kind: 'gate', item: id })[0].steps.find(step => step.name === 'receipt').payload.receipt;

  // The receipt names each failing case of the red check phase.
  assert.deepEqual(receiptOf(mixed).gate.phases.find(phase => phase.role === 'check').failures,
    [{ file: 'web/mixed.test.js', name: 'main case' }, { file: 'web/mixed.test.js', name: 'new case' }], JSON.stringify(receiptOf(mixed)).slice(0, 4000));

  const returned = getItem(board, mixed);
  assert.deepEqual([returned.item_status, returned.item_owner], ['claimed', builder], 'a new failure returns the item to its builder');
  const red1 = facts(board, mixed);
  assert.match(red1, new RegExp(`red at ${mixedSubmit.commit.slice(0, 12)}; failing parts:`, 'u'));
  assert.match(red1, /also fails on main: check web\/mixed\.test\.js \(main case\)/u, 'the main red is marked as main\'s');
  assert.match(red1, /new: check web\/mixed\.test\.js \(new case\)/u, 'the new failure is marked new');

  const passed = getItem(board, mainOnly);
  assert.deepEqual([passed.item_status, passed.item_commit], ['submitted', mainSubmit.commit], `a red only in main's cases never bounces the builder: ${facts(board, mainOnly)}`);
  assert.match(facts(board, mainOnly), /only in cases that also fail on main [0-9a-f]{12} \(not this item's; accepted\):\nalso fails on main: check web\/main\.test\.js \(main case\)/u);
});
