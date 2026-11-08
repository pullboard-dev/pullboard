/** @pullboard-test-input source-tree */
/** Real CLI additions prove size refusal and recorded override without changing the live board [B35,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { criterionSize } from '../index.js';
import { createE2eHelpers } from '../../../test/e2e-helpers.js';
import { fixtureAdd } from '../../../test/testkit-fixture.js';

/** Run the real CLI and require its successful versioned JSON result. */
function json(box, ...args) {
  const result = box.run(box.repo, ...args, '--json');
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

test('criterion scope deduplicates files and maps legacy paths to their actual cells [B35,C7]', () => {
  const catalog = [{ name: 'alpha', root: 'packages/alpha', paths: ['src/a.js'] }, { name: 'beta', root: 'packages/beta', paths: ['src/b.js'] }];
  const size = criterionSize('(1) Change src/a.js. (2) Prove src/a.js and src/b.js.', catalog);
  assert.deepEqual(size.files, ['src/a.js', 'src/b.js']);
  assert.deepEqual(size.cells, ['alpha', 'beta']);
  assert.equal(size.clauses, 2);
  assert.equal(size.score, 6);
  assert.equal(size.oversized, true);
  assert.equal(criterionSize('For cell alpha: update packages/alpha/a.js for version 0.9.4.').cells.length, 1);
  assert.deepEqual(criterionSize('Update alpha, beta and gamma cells.', [...catalog, { name: 'gamma', root: 'packages/gamma' }]).cells, ['alpha', 'beta', 'gamma']);
  assert.deepEqual(criterionSize('Update alpha, beta and gamma cells.').cells, []);
  assert.deepEqual(criterionSize('Update packages/alpha and packages/beta.').cells, ['alpha', 'beta']);
  assert.equal(criterionSize('One cell or at most three clauses.').cells.length, 0);
  assert.equal(criterionSize('1. Read; 2. Change; 3. Prove; 4. Publish.').clauses, 1);
  assert.equal(criterionSize('1. Read\n2. Change\n3. Prove\n4. Publish.').clauses, 4);
  assert.equal(criterionSize('(1) Read; (1) Change; (1) Prove; (1) Publish.').oversized, true);
});

test('real one-cell criteria do not turn surrounding prose into extra cells [B35,C7]', () => {
  const catalog = [{ name: 'seats', root: 'packages/seats', paths: ['src/agent-hook.js', 'src/github-origin.js',
    'src/line-capacity-board.js', 'src/seat-checkout.js', 'src/seats.js'] }, { name: 'link', root: 'packages/link' }];
  const criteria = [
    // #2266 and #2278 are real board criteria that the old prose scan falsely refused.
    'Found by core-942 on #1680 (importer and reason facts on #1680; code ready at a55953f61). After this item: the wrong-way edge from seats core into its shell is cut while keeping each binding surface its importers use; the shims src/agent-hook.js, src/github-origin.js, src/line-capacity-board.js, src/seat-checkout.js and src/seats.js are deleted and every importer uses packages/seats/index.js; node bin/cells-plan.js --check and the cell lints pass, and no behaviour changes. #2226 covers the other seven seats shims.',
    'Found by core-942 on #1695 (each alias, caller and reason in its facts). After this item namespace callers use explicit bindings or narrow ports, github core\'s relayMachineOwner and relayMachineContext read pure ports, view-lane callers are repointed under #2174\'s allowance (only to the module each deleted shim re-exported), the fourteen link shims are deleted, node bin/cells-plan.js --check and the cell lints pass, no move closure grows, and no behaviour changes.',
  ];
  for (const criterion of criteria) {
    const size = criterionSize(criterion, catalog);
    assert.equal(size.oversized, false, criterion);
    assert.ok(size.cells.every(name => name === 'seats'), 'only a named, catalogued cell is counted');
  }
  assert.deepEqual(criterionSize('The internal cells tools read once; check the cell lints.', catalog).cells, []);
  assert.equal(criterionSize('Use version 1.2.3 and section 4. Keep one cell.', catalog).clauses, 1);
});

test('add accepts one cell, refuses three cells and records an explicit size override [B35,C7]', t => {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const one = json(box, 'add', 'web', 'Small', '--specs', 'G1', '--criterion', 'Update packages/alpha/a.js and packages/alpha/b.js.').item;
  assert.equal(one.item_title, 'Small');
  const criterion = 'Update packages/alpha/a.js, packages/beta/b.js and packages/gamma/c.js.';
  const refusal = fixtureAdd(box.run, box.repo, 'web', 'Large', '--specs', 'G1', '--criterion', criterion, '--json');
  assert.notEqual(refusal.code, 0);
  const error = JSON.parse(refusal.out).error;
  assert.equal(error.code, 'ITEM_TOO_LARGE');
  assert.match(error.next, /one item per named cell.*alpha, beta, gamma/u);
  const forced = json(box, 'add', 'web', 'Explicit scope', '--specs', 'G1', '--criterion', criterion, '--force-size', 'one compatibility transaction').item;
  const shown = json(box, 'show', String(forced.item_id));
  const note = shown.thread.find(entry => entry.type === 'fact' && entry.text?.startsWith('Criterion size override:'));
  assert.ok(note, 'override must be a native item fact');
  assert.match(note.text, /one compatibility transaction/u);
  assert.match(note.text, /"cells":\["alpha","beta","gamma"\]/u);
  const blank = fixtureAdd(box.run, box.repo, 'web', 'Blank override', '--specs', 'G1', '--criterion', criterion, '--force-size', ' ', '--json');
  assert.equal(JSON.parse(blank.out).error.code, 'ITEM_SIZE_REASON');
});

test('add accepts three numbered clauses and refuses a fourth even inside one cell [B35,C7]', t => {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const criterion = '(1) Read packages/alpha/a.js. (2) Change it. (3) Prove it.';
  json(box, 'add', 'web', 'Three clauses', '--specs', 'G1', '--criterion', criterion);
  const refused = fixtureAdd(box.run, box.repo, 'web', 'Four clauses', '--specs', 'G1', '--criterion', criterion + ' (4) Also publish it.', '--json');
  assert.equal(JSON.parse(refused.out).error.code, 'ITEM_TOO_LARGE');
  assert.match(JSON.parse(refused.out).error.next, /at most three numbered clauses/u);
});
