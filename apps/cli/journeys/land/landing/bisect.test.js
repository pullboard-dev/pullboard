/** A batch red twice with no named failing file bisects its items instead of retrying [C7,#2858]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import { calls } from '../../../tests/fixtures/land/board.js';
import { diagnose } from '../../../../../packages/landing/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { FILES, landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

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

test('a real two-item batch red three times with no named file lands refusing twice, then splits and runs gates over single items [C7,#2858]', async () => {
  const box = landProject();
  const entries = FILES.slice(0, 2).map((file, index) => itemWorktree(box, index + 1, file));
  for (const entry of entries) submitItem(box, entry, 'PASS\n');
  for (const entry of entries) acceptItem(box, entry);
  box.env.LAND_UNNAMED_RED = '1';
  const firsts = [await box.runLocal(box.repo, 'land', '--max', '2', '--json'), await box.runLocal(box.repo, 'land', '--adopt', '--json')];
  for (const refused of firsts) assert.equal(JSON.parse(refused.out).error.code, 'LAND_DIAGNOSTIC', refused.out);
  const before = calls(box).length;
  const third = await box.runLocal(box.repo, 'land', '--adopt', '--json');
  const ran = calls(box).slice(before);
  assert.ok(ran.length >= 1 && JSON.parse(third.out).error?.code !== 'LAND_DIAGNOSTIC', `the third land splits and runs gates: ${third.out}${third.err}`);
  const traced = readFileSync(box.gate.trace ?? join(box.dir, 'gate-trace.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const fullRuns = traced.filter(row => !row.alone && row.files.length === 2).length;
  assert.ok(fullRuns <= 3, 'the identical two-item gate is never run a fourth time');
  assert.ok(traced.some(row => !row.alone && row.files.length === 1), 'a subset gate over one item ran after the split');
});
