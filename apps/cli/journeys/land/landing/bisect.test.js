/** A batch red twice with no named failing file bisects its items instead of retrying [C7,#2858]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnose } from '../../../../../packages/landing/index.js';

/** A landing state whose gate evidence holds `reds` unnamed reds, the current one included. */
function stateWith(reds, items = [{ id: 1 }, { id: 2 }]) {
  const gates = Array.from({ length: reds }, () => ({ isGreen: false, failures: [] }));
  return { config: {}, diagnosed: new Map(), batch: { logPath: '/nowhere/x.log', items, invariantEvidence: { version: 1, gates, diagnostics: [] } } };
}

test('the first and second unnamed reds still refuse LAND_DIAGNOSTIC; the third splits the batch instead [C7,#2858]', async () => {
  for (const reds of [1, 2]) {
    await assert.rejects(diagnose(stateWith(reds), [], { logPath: 'x' }), { code: 'LAND_DIAGNOSTIC' });
  }
  assert.deepEqual(await diagnose(stateWith(3), [], { logPath: 'x' }), [], 'no flakes and no throw, so the caller bisects its items');
});

test('a single-item batch with repeated unnamed reds still refuses, since there is nothing to split [C7,#2858]', async () => {
  await assert.rejects(diagnose(stateWith(3, [{ id: 1 }]), [], { logPath: 'x' }), { code: 'LAND_DIAGNOSTIC' });
});

// CONTROLLER_ONLY: the batch carries unnamed reds across lands (LAND_DIAGNOSTIC, --adopt) and splits on the third; a pulled land job runs once and returns its items, with no batch to adopt or split [C7,#2858].
test('a real two-item batch red three times with no named file lands refusing twice, then splits and runs gates over single items [C7,#2858]', { skip: 'CONTROLLER_ONLY: deleted with #6807' }, () => {});
