/** Shared pieces of the landing prune journeys: one real landing pass in a child process and two accepted item folders [R3,C7]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFixtureChild } from '../child.js';

/** The model name the landing fixture seat reports. */
const FIXTURE_MODEL = 'landing-fixture';
/** Run one real landing pass in a child process and return its lines and any refusal. */
export function landOnce(box, ageMs = 0) {
  const href = path => pathToFileURL(new URL(path, import.meta.url).pathname).href;
  const source = [
    `import * as store from ${JSON.stringify(href('../../../../../packages/store/index.js'))};`,
    `import { openBoard } from ${JSON.stringify(href('../../../../lib/index.js'))};`,
    `import { loadConfig } from ${JSON.stringify(href('../../../../../packages/config/index.js'))};`,
    `import { runLandingBatch } from ${JSON.stringify(href('../../../../../packages/landing/index.js'))};`,
    `import { landingPorts } from ${JSON.stringify(href('../../../tests/fixtures/landing/ports.js'))};`,
    `import { checkAtCommit } from ${JSON.stringify(href('../../../../runner/index.js'))};`,
    "import { join } from 'node:path';",
    'const [root] = process.argv.slice(1);',
    'const board = openBoard(join(root, ".git", "pullboard", "board.sqlite"));',
    'const lines = [];',
    `const aged = ${Number(ageMs)}; if (aged) board.clock = { ...board.clock, now: () => new Date(Date.now() + aged) };`,
    'try {',
    'const write = async (operation, args) => board.enginePorts.store[operation](board, ...args);',
    'let error = null; try { await runLandingBatch({ landingPorts, checkAtCommit, root, board, config: loadConfig(root), owner: "coordinator", write, say: line => lines.push(line), checkLease: async () => {}, checkLeaseNow: () => {} }); } catch (caught) { error = { code: caught.code, message: caught.message }; }',
    'console.log(JSON.stringify({ error, lines }));',
    '} finally { store.closeBoard(board); }',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo], { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

/** The paths Git lists as registered worktrees of a repository. */
export function worktrees(box) {
  return box.git(box.repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
}

/** Two accepted items in separate item folders, the second holding uncommitted work. */
export function acceptedFolders(box, { itemWorktree, submitItem, acceptItem }) {
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
