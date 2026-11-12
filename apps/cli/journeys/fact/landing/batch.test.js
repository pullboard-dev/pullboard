/** @pullboard-test-input apps/cli/tests/fixtures/landing/ports.js apps/lib/index.js apps/lib/src/io/landing/candidate.js apps/runner/index.js packages/config/index.js packages/landing/index.js packages/store/index.js */
/** Automatic landing drops a batch whose items already landed, and a dirty batch resets once then stops [B35,B3]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import { recordManualMergedItems } from '../../../tests/fixtures/land/board.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

/** A separate-publish landing project with one accepted item. */
function acceptedProject() {
  const box = landProject();
  const path = join(box.repo, 'pullboard.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), landing: { perItem: false, manualOverride: true, publish: 'separate' } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: land separately');
  const entry = itemWorktree(box, 1);
  submitItem(box, entry);
  acceptItem(box, entry);
  return { box, entry };
}

/**
 * Record an interrupted merging batch for the item at main's tip, with its own worktree, then run the landing once
 * (adopting it) and return the batch records and the landing's lines. `dirty` stages a file in the batch worktree;
 * `reset` marks the batch as already reset once.
 */
function adoptBatch(box, entry, { dirty = false, reset = false, runs = 1 } = {}) {
  const source = [
    `import * as store from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/store/index.js')).href)};`,
    `import { openBoard } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../lib/index.js')).href)};`,
    `import { loadConfig } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/config/index.js')).href)};`,
    `import { runLandingBatch } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/landing/index.js')).href)};`,
    `import { landingPorts } from ${JSON.stringify(new URL('../../../tests/fixtures/landing/ports.js', import.meta.url).href)};`,
    `import { checkAtCommit } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../runner/index.js')).href)};`,
    `const candidateWorkerFile = ${JSON.stringify(join(import.meta.dirname, '../../../../lib/src/io/landing/candidate.js'))};`,
    "import { join } from 'node:path'; import { execFileSync } from 'node:child_process'; import { mkdirSync, writeFileSync } from 'node:fs';",
    'const [root, itemId, commit, dirty, reset, runs] = process.argv.slice(1);',
    'const board = openBoard(join(root, ".git", "pullboard", "board.sqlite"));',
    'const lines = [], errors = [];',
    'try {',
    'const write = async (operation, args) => board.enginePorts.store[operation](board, ...args);',
    'const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();',
    'const id = "00000000-0000-4000-8000-000000000001", directory = join(root, ".git", "pullboard", "landings", id), worktree = join(directory, "worktree");',
    'mkdirSync(directory, { recursive: true }); execFileSync("git", ["worktree", "add", "-q", "--detach", worktree, base], { cwd: root });',
    'if (dirty === "1") { writeFileSync(join(worktree, "engine-staged.txt"), "staged step output\\n"); execFileSync("git", ["add", "engine-staged.txt"], { cwd: worktree }); }',
    'const entry = { id: Number(itemId), commit };',
    'await write("recordLandingBatch", [{ agentId: "coordinator", batch: { version: 1, id, startedAt: new Date().toISOString(), base, tip: base, branch: "refs/heads/main", root: worktree, candidates: [entry], items: [entry], conflicts: [], blocked: [], state: "merging", owner: "coordinator", pid: 999999, host: "fixture", logPath: join(directory, "logs", "batch.log"), revision: 0, ...(reset === "1" ? { dirtyReset: true } : {}) } }]);',
    'for (let run = 0; run < Number(runs); run++) {',
    '  try { await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, root, board, config: loadConfig(root), owner: "coordinator", adopt: run === 0, write, say: line => lines.push(line), checkLease: async () => {}, checkLeaseNow: () => {} }); }',
    '  catch (failure) { errors.push(failure.code ?? String(failure)); }',
    '}',
    'const batches = store.landingBatches(board);',
    'console.log("RESULT " + JSON.stringify({ errors, lines, batch: batches.find(row => row.id === id), others: batches.filter(row => row.id !== id).map(row => row.state), merged: store.getItem(board, Number(itemId)).item_merged_commit, worktree }));',
    '} finally { store.closeBoard(board); }',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, String(entry.item), entry.commit, dirty ? '1' : '0', reset ? '1' : '0', String(runs)],
    { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.split('\n').find(line => line.startsWith('RESULT ')).slice('RESULT '.length));
}

test('clause 1: a batch whose every item already landed another way is dropped and its worktree removed [B35,B3]', () => {
  const { box, entry } = acceptedProject();
  recordManualMergedItems(box, [entry]);
  const result = adoptBatch(box, entry);
  assert.deepEqual(result.errors, [], JSON.stringify(result.lines));
  assert.equal(result.batch.state, 'blocked');
  assert.equal(result.batch.dropped, 'every item already landed another way');
  assert.equal(existsSync(result.worktree), false, 'the dropped batch worktree is removed');
  assert.ok(result.lines.some(line => line.includes(`#${entry.item} already landed`)), result.lines.join('\n'));
});

test('a dirty batch worktree is reset to its base once and the batch lands [B35,B3]', () => {
  const { box, entry } = acceptedProject();
  const result = adoptBatch(box, entry, { dirty: true });
  assert.ok(!result.errors.includes('LAND_DIRTY'), `the first dirty adoption resets instead of refusing: ${result.errors}`);
  assert.equal(result.batch.dirtyReset, true, 'the batch records its one reset');
  assert.equal(result.batch.state, 'landed', JSON.stringify(result.batch));
  assert.ok(result.merged, 'the item lands after the reset');
});

test('a batch dirty again after its one reset stops blocked and is never retried [B35,B3]', () => {
  const { box, entry } = acceptedProject();
  const result = adoptBatch(box, entry, { dirty: true, reset: true, runs: 3 });
  assert.equal(result.errors.filter(code => code === 'LAND_DIRTY').length, 1, `exactly one refusal, no loop: ${result.errors}`);
  assert.equal(result.batch.state, 'blocked');
  assert.equal(result.batch.refusal.code, 'LAND_DIRTY', 'the refusal is recorded where the coordinator sees blocked batches');
});
