/** pullboard stats tests names test files that failed the gates of many unrelated items [C7]. @pullboard-test-input source-cell apps/cli packages/store */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { main } from '../../../fixtures/native.js';
import { cli } from '../../../fixtures/next/take.js';
import { fixture } from '../../../fixtures/next/take.js';

const KEY = '1'.repeat(64);
const CONTEXT = '2'.repeat(64);
const FILE = 'packages/demo/tests/flaky.test.js';

/** Seed one failing gate row per item for FILE, each shard taking 3 minutes. */
function seedFails(box, items) {
  const at = box.clock.now().getTime() - 3_600_000;
  for (const item of items) {
    const receipt = `gate:${item}:s1`;
    store.recordTestResults(box.board.db, { receipt, origin: 'gate', at, rows: [{ file: FILE, inputKey: KEY, command: 'proof', context: CONTEXT, status: 'fail' }] });
    for (const [name, when] of [['claimed', at], ['receipt', at + 180_000]]) {
      box.board.db.prepare('INSERT INTO job_step (job_step_job, job_step_name, job_step_at) VALUES (?, ?, ?)').run(receipt, name, when);
    }
  }
}

/** Run a command without --json and return its exit code and printed text. */
async function plain(box, args) {
  let out = '', err = '';
  const code = await main(args, { cwd: box.root, clock: box.clock, stdout: { isTTY: false, write: part => { out += part; } }, stderr: { write: part => { err += part; } } });
  return { code, out, err };
}

test('cli.stats-costly-tests.table-and-summary: clause 2: five items failing one file print the table and the plain stats summary line [C7]', async t => {
  const box = await fixture(t);
  seedFails(box, [101, 102, 103, 104, 105]);
  const tests = await plain(box, ['stats', 'tests']);
  assert.equal(tests.code, 0, tests.out + tests.err);
  assert.match(tests.out, /file \| items \| runs \| runner-min/u);
  assert.ok(tests.out.includes(`${FILE} | #101 #102 #103 #104 #105 | 5 | 15`), tests.out);
  const stats = await plain(box, ['stats']);
  assert.equal(stats.code, 0, stats.out + stats.err);
  assert.ok(stats.out.includes(`costly tests: 1 files in 24h, top ${FILE} 5 items 15 runner-min`), stats.out);
});

test('cli.stats-costly-tests.empty-window: clause 2: a window with too few failing items prints the empty-window line [C7]', async t => {
  const box = await fixture(t);
  seedFails(box, [101, 102, 103, 104]);
  const tests = await plain(box, ['stats', 'tests']);
  assert.equal(tests.code, 0, tests.out + tests.err);
  assert.ok(tests.out.includes('no test file failed the gates of 5 or more unrelated items in 24h'), tests.out);
  const stats = await plain(box, ['stats']);
  assert.ok(stats.out.includes('costly tests: 0 files in 24h'), stats.out);
});

test('cli.stats-costly-tests.json-document: clause 2: --json prints the versioned document with since, minItems and files [C7]', async t => {
  const box = await fixture(t);
  seedFails(box, [101, 102, 103]);
  const json = await cli(box, box.root, ['stats', 'tests', '--min-items', '3', '--since', '2h']);
  assert.equal(json.code, 0, json.out + json.err);
  assert.deepEqual(json.document, { version: 1, since: '2h', minItems: 3, files: [{ file: FILE, items: [101, 102, 103], runs: 3, runnerMinutes: 9 }] });
  const none = await cli(box, box.root, ['stats', 'tests', '--since', '30m']);
  assert.deepEqual(none.document, { version: 1, since: '30m', minItems: 5, files: [] });
});
