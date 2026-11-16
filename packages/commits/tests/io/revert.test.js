/** The guard mutation uses only its caller's trusted check operation [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { guardRevertNote } from '../../index.js';

/** Own one disposable scratch source file; these port controls do not claim a native gate receipt. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-guard-port-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'guard.js'), 'before\nprotected\nafter\n');
  return { root, item: { item_id: 1, item_criterion: 'guard: guard.js:2-2' } };
}

test('guard mutation calls the supplied check port with its actual lease and preserves other source [C7,V4]', async t => {
  const { root, item } = fixture(t), lease = { token: 'owned-port-fixture' };
  let calls = 0;
  /** Exercise the genuine mutation on an owned source file without executing a substitute gate. */
  const checkAtCommit = (selectedRoot, selectedItem, options) => {
    calls++;
    assert.equal(selectedRoot, root);
    assert.equal(selectedItem, item);
    assert.equal(options.gateLease, lease);
    assert.deepEqual(options.guard, { text: 'guard.js:2-2', path: 'guard.js', from: 2, to: 2 });
    assert.equal(options.mutate(root), '');
    assert.equal(readFileSync(join(root, 'guard.js'), 'utf8'), 'before\nafter\n');
    return { state: 'red' };
  };
  assert.equal(await guardRevertNote(root, item, lease, { checkAtCommit }), '\nguard guard.js:2-2 reverted: check red; restored: check green');
  assert.equal(calls, 1);
});

test('the check port cannot turn green, unavailable or missing guard evidence into a valid guard [C7,V4]', async t => {
  const { root, item } = fixture(t);
  for (const [state, code] of [['pass', 'GUARD_CANNOT_FAIL'], ['unverified', 'CHECK_UNVERIFIED']]) {
    await assert.rejects(guardRevertNote(root, item, {}, { checkAtCommit: () => ({ state, stage: 'check' }) }), { code });
  }
  const missing = { ...item, item_criterion: 'guard: absent.js:1-1' };
  await assert.rejects(guardRevertNote(root, missing, {}, { checkAtCommit: (_root, _item, options) => {
    assert.match(options.mutate(root), /absent\.js is not in the submitted commit/u);
    return { state: 'red' };
  } }), { code: 'GUARD_NOT_FOUND' });
  assert.equal(readFileSync(join(root, 'guard.js'), 'utf8'), 'before\nprotected\nafter\n');
  assert.equal(await guardRevertNote(root, { item_criterion: 'No named guard.' }, {}, { checkAtCommit: () => {
    assert.fail('a guard-free item must not call its check port');
  } }), '');
});
