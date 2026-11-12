/** @pullboard-test-input apps/cli/tests/fixtures/landing/ports.js apps/lib/index.js apps/lib/src/io/landing/candidate.js apps/runner/index.js packages/config/index.js packages/landing/index.js packages/store/index.js */
/** The trunk finish moves the trunk ref by compare-and-swap whatever the primary checkout holds, and refuses aloud when the ref moved [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import {
  privateFixtureFiles,
  runFixtureChild,
} from '../../../tests/fixtures/child.js';
import { moveTrunkRef } from '../../../../../packages/landing/index.js';

/** The model name every landing fixture seat reports. */
const FIXTURE_MODEL = 'landing-fixture';
const e2e = createE2eHelpers();
const scratch = [];
after(() => {
  e2e.cleanup();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

/** Run one real landing pass and return its lines, the error if any, and the item row. */
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

test('clause 1: a landing moves the trunk ref to the batch tip with an untracked file in the primary checkout, which survives [C7]', () => {
  const box = landProject({ withWorktree: false });
  box.env.PULLBOARD_MODEL = FIXTURE_MODEL;
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { manualOverride: true, publish: 'separate' } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: land separately');
  const entry = itemWorktree(box, 1);
  submitItem(box, entry, 'PASS\n');
  acceptItem(box, entry);
  mkdirSync(join(box.repo, 'docs'), { recursive: true });
  writeFileSync(join(box.repo, 'docs', 'stray-helper.sh'), 'echo stray\n');
  const result = landOnce(box, entry.item);
  assert.equal(result.error, null, JSON.stringify(result));
  assert.ok(result.item.merged, `the item landed: ${JSON.stringify(result.item)}`);
  assert.equal(box.git(box.repo, 'rev-parse', 'main').trim(), result.item.merged, 'the trunk ref names the landed commit');
  assert.ok(existsSync(join(box.repo, 'docs', 'stray-helper.sh')), 'the untracked file survives');
  assert.ok(existsSync(join(box.repo, 'web', 'land-1.test.js')), 'the primary checkout holds the landed tracked file');
  assert.ok(result.lines.some(line => /refs\/heads\/main moved from [0-9a-f]{40} to [0-9a-f]{40}/u.test(line)), result.lines.join('\n'));
  assert.ok(!result.lines.some(line => line.includes('fast-forwarded')), 'no line claims a fast-forward');
});

/** Run git in a directory and return trimmed stdout. */
function sh(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
}

test('clause 2: a trunk ref that moved before the finish records the batch blocked with LAND_MAIN_MOVED naming both commits and never says fast-forwarded [C7]', async () => {
  const dir = privateFixtureFiles('finish-moved-').root;
  scratch.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  sh(dir, 'add', 'a.txt');
  sh(dir, 'commit', '-q', '-m', 'base');
  const base = sh(dir, 'rev-parse', 'HEAD');
  sh(dir, 'checkout', '-q', '-b', 'batch');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  sh(dir, 'add', 'b.txt');
  sh(dir, 'commit', '-q', '-m', 'batch tip');
  const tip = sh(dir, 'rev-parse', 'HEAD');
  sh(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'c.txt'), 'c\n');
  sh(dir, 'add', 'c.txt');
  sh(dir, 'commit', '-q', '-m', 'main moved');
  const moved = sh(dir, 'rev-parse', 'HEAD');
  const lines = [];
  const records = [];
  const state = {
    root: dir, batch: { id: 7, base, tip, revision: 3, state: 'trunk' }, board: { clock: { now: () => new Date(0) } },
    say: line => lines.push(line),
    write: async (operation, args) => { records.push({ operation, batch: args[0].batch }); return args[0].batch; },
  };
  await assert.rejects(() => moveTrunkRef(state), error => error.code === 'LAND_MAIN_MOVED' && [base, tip, moved].every(commit => error.message.includes(commit)));
  assert.equal(sh(dir, 'rev-parse', 'main'), moved, 'the ref stays where it was');
  assert.equal(records.length, 1);
  assert.equal(records[0].operation, 'recordLandingBatch');
  assert.equal(records[0].batch.state, 'blocked');
  assert.equal(records[0].batch.refusal.code, 'LAND_MAIN_MOVED');
  assert.ok([base, tip, moved].every(commit => records[0].batch.refusal.message.includes(commit)));
  assert.ok(lines.some(line => line.includes('not moved') && line.includes(moved)), lines.join('\n'));
  assert.ok(!lines.some(line => line.includes('fast-forwarded')));
});
