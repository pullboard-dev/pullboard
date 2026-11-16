/** Landing failures retain their assertion evidence for the next builder [C7,B22]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { landingFailures } from '../../../../packages/landing/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { settleLand } from '../../tests/fixtures/land/settle.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import {
  json,
  onBoard,
} from '../../tests/fixtures/land/board.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, itemWorktree, submitItem, acceptItem, moveMainPastSubmit } = makeLandProjectFixtures(e2e);

test('a landing reopen carries the exact failing assertion [C7,B22]', async () => {
  const box = landProject();
  // The default shape: no affectedTests, so the landing gate runs the whole suite and sees the red file, as in land/red-returns [C7].
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  delete config.affectedTests;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  box.git(box.repo, 'commit', '-q', '-am', 'chore: the init default has no affectedTests');
  box.git(box.repo, 'push', '-q', 'origin', 'main');
  const gate = join(box.dir, 'land-gate.cjs');
  const source = readFileSync(gate, 'utf8');
  writeFileSync(gate, source.replace("console.log('  error: fixture behavior is red');", "console.log('  error: fixture behavior is red'); console.log('  expected: 7'); console.log('  actual: 9');"));
  const entry = itemWorktree(box, 1, 'web/land-1.test.js');
  box.env.LAND_SUPPRESS_RED = '1';
  submitItem(box, entry, 'RED\n');
  acceptItem(box, entry);
  delete box.env.LAND_SUPPRESS_RED; // the switch folder mirrors the delete to the pulled gate, so the red shows
  // The submit ran with its red suppressed; move main so the landing runs its own gate instead of reusing that receipt (#3685).
  moveMainPastSubmit(box);
  const base = box.git(box.repo, 'rev-parse', 'main');
  const landing = box.run(box.repo, 'land', '--json');
  // The pulled land job returns the red item on its receipt; land itself offers the job and exits 0 [#4265].
  const settled = await settleLand(box, JSON.parse(landing.out));
  assert.deepEqual(settled.landed, [], `every candidate is a culprit, so nothing lands: ${landing.err}${landing.out}${JSON.stringify(settled.landJob ?? {})}`);
  assert.equal(settled.batch.state, 'blocked', JSON.stringify(settled.landJob ?? {}));
  const item = json(box, box.repo, 'show', String(entry.item));
  assert.equal(item.item_status, 'open');
  const thread = onBoard(box, board => store.itemThread(board, entry.item));
  // A pulled landing's red returns through the board, which records the runner's failing-case lines as a "Land job ... red" note [P7,B22].
  const fact = thread.find(row => row.type === 'fact' && /^Land job \S+ red:/u.test(row.text));
  assert.ok(fact, `reopen attaches the assertion evidence: ${JSON.stringify(thread.map(row => row.text ?? row.kind))}`);
  for (const expected of [entry.file, 'keeps the landed behavior', 'fixture behavior is red', 'expected: 7', 'actual: 9']) assert.ok(fact.text.includes(expected), `${expected} in ${fact.text}`);
  const reopened = thread.find(row => row.kind === 'reopen');
  assert.match(reopened.detail?.note ?? '', /land job \S+ checked the merged tree red/u, 'the reopen names the red landing');
  const snapshot = onBoard(box, board => exportBoard(board));
  const replica = openBoard(':memory:');
  try {
    importBoard(replica, snapshot);
    const replayed = store.itemThread(replica, entry.item);
    assert.equal(replayed.find(row => row.type === 'fact' && /^Land job \S+ red:/u.test(row.text)).text, fact.text);
  } finally { store.closeBoard(replica); }
});

test('long assertion evidence is explicitly truncated [C7,B22]', () => {
  const output = `not ok 1 - long failure\n  location: /project/test/a.test.js:1:1\n  error: ${'x'.repeat(3000)}\n  ...\n`;
  const [failure] = landingFailures(output, '/project');
  assert.match(failure.assertion, /truncated at 2 KB/u);
  assert.ok(Buffer.byteLength(failure.assertion) < 2100);
  const [unicode] = landingFailures(output.replace('x'.repeat(3000), '😀'.repeat(1000)), '/project');
  assert.doesNotMatch(unicode.assertion, /\uFFFD/u, 'truncation never splits a UTF-8 character');
});

test('the spec reporter preserves the assertion with its source case [C7,B22]', () => {
  const output = 'test at test/a.test.js:4:1\n✖ nested case (2ms)\n  error: expected 7, got 9\n';
  const [failure] = landingFailures(output, '/project');
  assert.equal(failure.file, 'test/a.test.js');
  assert.equal(failure.name, 'nested case');
  assert.equal(failure.assertion, 'error: expected 7, got 9');
});

test('nested TAP failures retain their parent and subtest names [C7,B22]', () => {
  const output = '# Subtest: parent case\n    # Subtest: child case\n    not ok 1 - child case\n      location: /project/test/a.test.js:1:1\n      error: wrong result\n      expected: 7\n      actual: 9\n      ...\n';
  const [failure] = landingFailures(output, '/project');
  assert.deepEqual(failure.caseNames, ['parent case', 'child case']);
  assert.match(failure.assertion, /expected: 7/u);
  assert.match(failure.assertion, /actual: 9/u);
});

test('equally named failures in different parent cases remain distinct [C7,B22]', () => {
  const output = ['first', 'second'].map(parent => `# Subtest: ${parent}\n    # Subtest: child\n    not ok 1 - child\n      location: /project/test/a.test.js:1:1\n      error: ${parent} failure\n      ...\n`).join('');
  const failures = landingFailures(output, '/project');
  assert.deepEqual(failures.map(row => row.caseNames), [['first', 'child'], ['second', 'child']]);
  assert.match(failures[0].assertion, /first failure/u);
  assert.match(failures[1].assertion, /second failure/u);
});
