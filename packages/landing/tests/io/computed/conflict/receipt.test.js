/** @pullboard-test-input test-tree */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { fixtureCommittedGraph } from '../../../../../store/tests/fixtures/cell.js';
import { runFixtureGit } from '../../../../../store/tests/fixtures/cell.js';
import { requireComputedConflictObjects } from '../../../../src/io/computed/conflict/receipt.js';

const REPO = resolve(import.meta.dirname, '../../../../../../');
const TARGET = resolve(REPO, 'packages/landing/src/io/computed/conflict/receipt.js');

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
  const script = `
    import { createRequire } from 'node:module';
    const requireModule = createRequire(import.meta.url);
    const Module = requireModule('node:module');
    const loaded = [];
    const original = Module._load;
    Module._load = function (request, parent, isMain) {
      if (parent?.filename === ${JSON.stringify(TARGET)} && request.endsWith('merge/index.js')) loaded.push(request);
      return original.call(this, request, parent, isMain);
    };
    await import(${JSON.stringify(pathToFileURL(TARGET).href)});
    if (loaded.length) throw new Error('merge barrel loaded during cold import: ' + loaded.join(', '));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
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
  assert.equal(existsSync(join(REPO, 'packages/merge/trunk.js')), false);
});
