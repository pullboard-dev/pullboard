/** Criterion size counts files, clauses and named cells [B35,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { criterionSize } from '../../index.js';

test('items.size.criterion-scope: criterion scope deduplicates files and maps legacy paths to their actual cells [B35,C7]', () => {
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
  assert.equal(criterionSize('(1) Read; (2) Change; (3) Prove; (4) Publish.').oversized, true);
});

test('items.size.one-cell-prose: real one-cell criteria do not turn surrounding prose into extra cells [B35,C7]', () => {
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

test('items.size.number-in-text-not-label: clause 1: a bar with three numbered lines whose text holds a parenthesised count and a call argument counts three clauses [B35,C7,#11847]', () => {
  const bar = '1. Show the count (312) in the status line.\n2. Call get(1) on the store.\n3. Prove both.';
  const size = criterionSize(bar);
  assert.equal(size.clauses, 3);
  assert.equal(size.oversized, false);
});

test('items.size.ordered-paren-labels: clause 2: a bar labelled with parenthesised 1 to 4 in order counts four clauses and is oversized [B35,C7,#11847]', () => {
  const size = criterionSize('(1) Read; (2) Change; (3) Prove; (4) Publish.');
  assert.equal(size.clauses, 4);
  assert.equal(size.oversized, true);
  assert.equal(criterionSize('(2) Change; (1) Read.').clauses, 1);
});
