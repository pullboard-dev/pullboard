/** The landing step prunes a landed batch's gone seats and keeps live seats and unsaved work [R3,C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { pathToFileURL } from 'node:url';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';

/** The model name the landing fixture seat reports. */
const FIXTURE_MODEL = 'landing-fixture';
const e2e = createE2eHelpers();
after(() => e2e.cleanup());
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

/** Run one real landing pass in a child process and return its lines and any refusal. */
function landOnce(box, ageMs = 0) {
  const href = path => pathToFileURL(new URL(path, import.meta.url).pathname).href;
  const source = [
    `import * as store from ${JSON.stringify(href('../../../../../packages/store/index.js'))};`,
    `import { openBoard } from ${JSON.stringify(href('../../../../lib/index.js'))};`,
    `import { loadConfig } from ${JSON.stringify(href('../../../../../packages/config/index.js'))};`,
    `import { runLandingBatch } from ${JSON.stringify(href('../../../../../packages/landing/index.js'))};`,
    `import { landingPorts } from ${JSON.stringify(href('../../../tests/fixtures/landing/ports.js'))};`,
    `import { checkAtCommit } from ${JSON.stringify(href('../../../../runner/index.js'))};`,
    `const candidateWorkerFile = ${JSON.stringify(new URL('../../../../lib/src/io/landing/candidate.js', import.meta.url).pathname)};`,
    "import { join } from 'node:path';",
    'const [root] = process.argv.slice(1);',
    'const board = openBoard(join(root, ".git", "pullboard", "board.sqlite"));',
    'const lines = [];',
    `const aged = ${Number(ageMs)}; if (aged) board.clock = { ...board.clock, now: () => new Date(Date.now() + aged) };`,
    'try {',
    'const write = async (operation, args) => board.enginePorts.store[operation](board, ...args);',
    'let error = null; try { await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, root, board, config: loadConfig(root), owner: "coordinator", write, say: line => lines.push(line), checkLease: async () => {}, checkLeaseNow: () => {} }); } catch (caught) { error = { code: caught.code, message: caught.message }; }',
    'console.log(JSON.stringify({ error, lines }));',
    '} finally { store.closeBoard(board); }',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo], { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

/** The paths Git lists as registered worktrees of a repository. */
function worktrees(box) {
  return box.git(box.repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
}

/** Two accepted items in separate item folders, the second holding uncommitted work. */
function acceptedFolders(box) {
  box.env.PULLBOARD_MODEL = FIXTURE_MODEL;
  const clean = itemWorktree(box, 1);
  const dirty = itemWorktree(box, 2);
  const folder = entry => `${entry.path}-item-${entry.item}`;
  for (const entry of [clean, dirty]) submitItem(box, entry, 'PASS\n');
  for (const entry of [clean, dirty]) acceptItem(box, entry);
  writeFileSync(join(folder(dirty), 'unsaved.txt'), 'work that is not committed\n');
  assert.ok(worktrees(box).includes(folder(clean)) && worktrees(box).includes(folder(dirty)), 'both item folders exist before the landing');
  return { clean, dirty, folder };
}

test('a real landing keeps the item folders of a seat that is still live and says why [R3,C7]', () => {
  const box = landProject({ withWorktree: false });
  const { clean, folder } = acceptedFolders(box);
  const result = landOnce(box);
  assert.equal(result.error, null, JSON.stringify(result));
  assert.ok(result.lines.some(line => line.startsWith('landed ')), result.lines.join('\n'));
  assert.ok(worktrees(box).includes(folder(clean)) && existsSync(folder(clean)), 'a live seat keeps its landed folder');
  assert.ok(result.lines.some(line => line.includes('kept') && line.includes(folder(clean)) && line.includes('seat is live')), result.lines.join('\n'));
});

test('a real landing prunes the landed folder of a gone seat and keeps the folder holding unsaved work [R3,C7]', () => {
  const box = landProject({ withWorktree: false });
  const { clean, dirty, folder } = acceptedFolders(box);
  const result = landOnce(box, 3_600_000);
  assert.equal(result.error, null, JSON.stringify(result));
  assert.ok(result.lines.some(line => line.startsWith('landed ')), result.lines.join('\n'));
  const after = worktrees(box);
  assert.ok(!after.includes(folder(clean)) && !existsSync(folder(clean)), `the landed clean folder is pruned: ${result.lines.join('\n')}`);
  assert.ok(after.includes(folder(dirty)) && existsSync(join(folder(dirty), 'unsaved.txt')), 'the folder with uncommitted work is kept');
  assert.ok(result.lines.some(line => line.includes('kept') && line.includes(folder(dirty)) && /dirty worktree/u.test(line)), result.lines.join('\n'));
  assert.ok(after.includes(clean.path) && after.includes(dirty.path), 'the seat checkouts stay registered');
  assert.ok(box.git(box.repo, 'branch', '--list', 'web/land-1').includes('web/land-1'), 'the seat branch is kept');
});
