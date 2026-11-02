/** Landing failures retain their assertion evidence for the next builder [C7,B22]. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../src/board.js';
import { landingFailures } from '../packages/landing/index.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { makeLandProjectFixtures } from './land-project-fixture.js';
import { json, onBoard } from './land-board-fixture.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

test('a landing reopen carries the exact failing assertion [C7,B22]', () => {
  const box = landProject();
  const gate = join(box.dir, 'land-gate.cjs');
  const source = readFileSync(gate, 'utf8');
  writeFileSync(gate, source.replace("console.log('  error: fixture behavior is red');", "console.log('  error: fixture behavior is red'); console.log('  expected: 7'); console.log('  actual: 9');"));
  const entry = itemWorktree(box, 1, 'web/land-1.test.js');
  box.env.LAND_SUPPRESS_RED = '1';
  submitItem(box, entry, 'RED\n');
  acceptItem(box, entry);
  delete box.env.LAND_SUPPRESS_RED;
  const base = box.git(box.repo, 'rev-parse', 'main');
  json(box, box.repo, 'land');
  const item = json(box, box.repo, 'show', String(entry.item));
  assert.equal(item.item_status, 'open');
  const thread = onBoard(box, board => store.itemThread(board, entry.item));
  const fact = thread.find(row => row.type === 'fact' && row.text.startsWith('Landing failure evidence:'));
  assert.ok(fact, 'reopen attaches the assertion evidence');
  for (const expected of [entry.file, 'keeps the landed behavior', 'fixture behavior is red', 'expected: 7', 'actual: 9', base, entry.commit]) assert.ok(fact.text.includes(expected), expected);
  assert.ok(thread.some(row => row.kind === 'reopen' && /landing failure evidence/u.test(row.detail?.note ?? '')), 'next step points to the evidence');
});

test('long assertion evidence is explicitly truncated [C7,B22]', () => {
  const output = `not ok 1 - long failure\n  location: /project/test/a.test.js:1:1\n  error: ${'x'.repeat(3000)}\n  ...\n`;
  const [failure] = landingFailures(output, '/project');
  assert.match(failure.assertion, /truncated at 2 KB/u);
  assert.ok(Buffer.byteLength(failure.assertion) < 2100);
});
