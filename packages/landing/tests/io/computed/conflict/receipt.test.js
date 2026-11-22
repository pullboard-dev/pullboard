/** @pullboard-test-input test-tree */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fixtureCommittedGraph } from '../../../../../store/tests/fixtures/cell.js';
import { runFixtureGit } from '../../../../../store/tests/fixtures/cell.js';
import { staticImportClosure } from '../../../fixtures/conflict-import.js';
import { requireComputedConflictObjects } from '../../../../src/io/computed/conflict/receipt.js';

const REPO = resolve(import.meta.dirname, '../../../../../../');

/** Build two real Git histories whose same-line edits conflict at their tips. */
function conflictRepo(t) {
  const graph = fixtureCommittedGraph('pullboard-landing-receipt-');
  const root = graph.root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  graph.put('conflict.txt', 'base\n');
  graph.commit();
  runFixtureGit(['checkout', '-q', '-b', 'candidate'], { cwd: root });
  graph.put('conflict.txt', 'candidate\n');
  const head = graph.commit();
  runFixtureGit(['checkout', '-q', 'main'], { cwd: root });
  graph.put('conflict.txt', 'trunk\n');
  const trunk = graph.commit();
  const boardFile = join(root, '.git', 'pullboard', 'board.sqlite');
  graph.put('.git/pullboard/board.sqlite', 'fixture');
  return { root, boardFile, head, trunk };
}

test('landing.conflict.receipt-cold-import: clause 1: importing the receipt caller does not load packages/merge/index.js [C7]', () => {
  assert.equal(staticImportClosure('packages/landing/src/io/computed/conflict/receipt.js')
    .includes('packages/merge/index.js'), false, 'a cold caller import does not reach the merge barrel');
});

test('landing.io-computed-conflict-receipt.light-door-reaches-no-state-machine: clause 1: the landing light door does not statically reach the state machine [C7]', () => {
  assert.equal(staticImportClosure('packages/landing/light.js')
    .includes('packages/state/src/io/machine.js'), false, 'the landing light door does not reach the state machine');
});

test('landing.conflict.receipt-recorded-conflict: clause 2: a recorded Git conflict is verified by a synchronous call through the merge public door [C7]', t => {
  const repo = conflictRepo(t);
  const board = { db: { prepare: () => ({ all: () => [{ name: 'main', file: repo.boardFile }] }) } };
  const fields = { version: 2, id: randomUUID(), board: 'a'.repeat(32), item: 1, actor: 'core-fixture', head: repo.head,
    trunk: repo.trunk, files: ['conflict.txt'], at: '2026-11-22T00:00:00.000Z', submission: 1 };
  const receipt = { ...fields, digest: createHash('sha256').update(JSON.stringify(fields)).digest('hex') };
  assert.deepEqual(requireComputedConflictObjects(board, receipt), ['conflict.txt']);
});

/** @pullboard-world-pin the landing callers use the merge public door without widening the light door or layout. */
test('landing.conflict.light-door-unchanged: clause 3: merge light has no trunk exports and no trunk entry door is added [C7]', () => {
  const light = readFileSync(join(REPO, 'packages/merge/light.js'), 'utf8');
  assert.doesNotMatch(light, /^\s*export\s.*(?:trunkMerge|recordedTrunkMerge|refuseRecordedHistoryOverrides)/mu);
  assert.equal(readdirSync(join(REPO, 'packages/merge')).includes('trunk.js'), false);
});
