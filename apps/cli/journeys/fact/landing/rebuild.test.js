/** @pullboard-test-input source-tree */
/** A batch whose trunk moved outside its files while it gated is rebuilt on the new tip and lands; the rebuild records the base it left [C7]. */
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
import { validateLandingRevision } from '../../../../../packages/items/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('a rebuilt batch records the base it left and passes the revision guard; any other base change is refused [C7]', () => {
  const previous = { revision: 3, state: 'gating', base: 'a'.repeat(40), root: '/w', branch: 'refs/heads/main' };
  const rebuilt = { ...previous, base: 'b'.repeat(40), rebasedFrom: 'a'.repeat(40) };
  assert.doesNotThrow(() => validateLandingRevision(previous, rebuilt, 3));
  const other = { ...previous, base: 'c'.repeat(40) };
  assert.throws(() => validateLandingRevision(previous, other, 3), error => error.code === 'LAND_BATCH');
  const forged = { ...previous, base: 'c'.repeat(40), rebasedFrom: 'd'.repeat(40) };
  assert.throws(() => validateLandingRevision(previous, forged, 3), error => error.code === 'LAND_BATCH');
});

/** Run one real landing pass and return its lines, the error if any, the item row and main's tip. */
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
    'console.log(JSON.stringify({ error, lines, item: { status: item.item_status, merged: item.item_merged_commit } }));',
    '} finally { store.closeBoard(board); }',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, String(itemId)], { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

test('main moving outside the batch files during its gate rebuilds the batch on the new tip and lands it [C7]', () => {
  const box = landProject({ withWorktree: false });
  box.env.PULLBOARD_MODEL = 'landing-fixture';
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { manualOverride: true, publish: 'separate' } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: land separately');
  // The gate moves main once before the real gate runs: one docs commit, outside every file the batch changes.
  const mover = join(box.dir, 'move-main.cjs');
  writeFileSync(mover, [
    "const { execFileSync } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    `const repo = ${JSON.stringify(box.repo)};`,
    "const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];",
    "const log = execFileSync('git', ['log', '--format=%s', '-1', 'main'], { cwd: repo, env, encoding: 'utf8' });",
    "if (process.env.PULLBOARD_LANDING_RUN === '1' && !log.includes('moved outside')) {",
    "  writeFileSync(join(repo, 'docs-note.md'), 'moved\\n');",
    "  execFileSync('git', ['add', 'docs-note.md'], { cwd: repo, env });",
    "  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'docs: moved outside the batch'], { cwd: repo, env });",
    '}',
    '',
  ].join('\n'));
  const moving = JSON.parse(readFileSync(path, 'utf8'));
  moving.gate = `node ${JSON.stringify(mover)} && ${moving.gate}`;
  writeFileSync(path, JSON.stringify(moving, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: the gate moves main once');
  const entry = itemWorktree(box, 1);
  submitItem(box, entry, 'PASS\n');
  acceptItem(box, entry);
  // A landing tree equal to the submit tree reuses the submit receipt and runs no gate; one commit on main first makes the landing gate run.
  writeFileSync(join(box.repo, 'before-landing.md'), 'before\n');
  box.git(box.repo, 'add', 'before-landing.md');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: main moves before the landing');
  const result = landOnce(box, entry.item);
  assert.equal(result.error, null, JSON.stringify(result));
  assert.ok(result.lines.some(line => line.includes('outside this batch\'s files; rebuilding the batch on it')), result.lines.join('\n'));
  assert.ok(result.item.merged, `the item landed: ${JSON.stringify(result.item)}`);
  const subjects = box.git(box.repo, 'log', '--format=%s', '-5', 'main');
  assert.ok(subjects.includes('moved outside'), 'main keeps the commit that moved it');
});
