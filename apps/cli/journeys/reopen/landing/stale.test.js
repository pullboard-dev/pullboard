/** @pullboard-test-input apps/cli/tests/fixtures/landing/ports.js apps/lib/index.js apps/lib/src/io/landing/candidate.js apps/runner/index.js packages/config/index.js packages/landing/index.js packages/store/index.js */
/** A verdict made stale by a main change returns to its lane at once: withdrawn, reopened with no owner, recorded [B3,C7]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

/** A separate-publish landing project with no red of its own. */
function cleanProject() {
  const box = landProject({ withWorktree: false });
  box.env.PULLBOARD_MODEL = 'landing-fixture';
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { manualOverride: true, publish: 'separate' } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: land separately');
  return box;
}

/** Run one real landing pass and return the landing's lines, the item's row and its reopen events. */
function landOnce(box, itemId) {
  const source = [
    `import * as store from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/store/index.js')).href)};`,
    `import { openBoard } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../lib/index.js')).href)};`,
    `import { loadConfig } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/config/index.js')).href)};`,
    `import { runLandingBatch } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/landing/index.js')).href)};`,
    `import { landingPorts } from ${JSON.stringify(new URL('../../../tests/fixtures/landing/ports.js', import.meta.url).href)};`,
    `import { checkAtCommit } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../runner/index.js')).href)};`,
    `const candidateWorkerFile = ${JSON.stringify(join(import.meta.dirname, '../../../../lib/src/io/landing/candidate.js'))};`,
    "import { join } from 'node:path';",
    'const [root, itemId] = process.argv.slice(1);',
    'const board = openBoard(join(root, ".git", "pullboard", "board.sqlite"));',
    'const lines = [];',
    'try {',
    'const write = async (operation, args) => board.enginePorts.store[operation](board, ...args);',
    'let error = null; try { await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, root, board, config: loadConfig(root), owner: "coordinator", write, say: line => lines.push(line), checkLease: async () => {}, checkLeaseNow: () => {} }); } catch (caught) { error = { code: caught.code, message: caught.message }; }',
    'const item = store.getItem(board, Number(itemId));',
    'const reopens = store.events(board, { itemId: Number(itemId) }).filter(event => event.event_kind === "reopen").map(event => JSON.parse(event.event_detail));',
    'console.log(JSON.stringify({ error, lines, item: { status: item.item_status, verdict: item.item_verdict, owner: item.item_owner, merged: item.item_merged_commit }, reopens }));',
    '} finally { store.closeBoard(board); }',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, String(itemId)], { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

test('an accepted item whose file main changed after review is withdrawn and reopened to its lane with the file named [B3,C7]', () => {
  const box = cleanProject();
  const entry = itemWorktree(box, 1);
  submitItem(box, entry, '// PASS\n');
  acceptItem(box, entry);
  // Main now carries its own version of the same file, so the reviewed change no longer composes unchanged.
  assert.equal(commitFile(box, box.repo, entry.file, '// PASS, rewritten on main\n', 'test(web): main rewrites the same file [G1]').status, 0);
  const mainCommit = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  const result = landOnce(box, entry.item);
  assert.equal(result.error, null, JSON.stringify(result));
  assert.equal(result.item.merged, null, 'nothing landed');
  assert.equal(result.item.status, 'open', JSON.stringify(result.item));
  assert.equal(result.item.verdict, null, 'the accept is withdrawn');
  assert.equal(result.item.owner, null, 'no builder is reserved; any seat in the lane may take it');
  assert.equal(result.reopens.length, 1, JSON.stringify(result.reopens));
  const [reopen] = result.reopens;
  assert.ok(reopen.withdrawnVerdict, 'the reopen records the withdrawn verdict');
  assert.ok(reopen.note.includes(entry.file) && reopen.note.includes(mainCommit.slice(0, 12)), reopen.note);
  assert.ok(result.lines.some(line => line.startsWith(`STALE_VERDICT #${entry.item} reopened to its lane: ${entry.file}`)), result.lines.join('\n'));
  // A second pass finds nothing accepted and records no second reopen.
  const again = landOnce(box, entry.item);
  assert.equal(again.reopens.length, 1, 'the return is recorded once');
  assert.equal(again.item.status, 'open');
});

test('a stale verdict behind a full one-item batch still returns to its lane in the same pass [B3,C7]', () => {
  const box = cleanProject();
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { ...config.landing, perItem: true } }, null, 2));
  box.git(box.repo, 'commit', '-q', '-am', 'chore: one item per batch');
  const older = itemWorktree(box, 1);
  submitItem(box, older, '// PASS\n');
  acceptItem(box, older);
  const newer = itemWorktree(box, 2);
  submitItem(box, newer, '// PASS\n');
  acceptItem(box, newer);
  // The older accept goes stale while the newer one still composes, so the batch takes the newer item.
  assert.equal(commitFile(box, box.repo, older.file, '// PASS, rewritten on main\n', 'test(web): main rewrites the older file [G1]').status, 0);
  const result = landOnce(box, older.item);
  assert.equal(result.error, null, JSON.stringify(result));
  assert.equal(result.item.status, 'open', `the stale item behind the batch is reopened: ${JSON.stringify(result.item)}`);
  assert.equal(result.reopens.length, 1, JSON.stringify(result.reopens));
  assert.ok(result.lines.some(line => line.startsWith(`STALE_VERDICT #${older.item} reopened to its lane`)), result.lines.join('\n'));
});

