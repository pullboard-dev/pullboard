/** The scheduled wake's own io lands an accepted item through landAfterAcceptance [B35,B3]. */
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
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { wakeIo } from '../../src/io/landing/automatic.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

/** Rewrite the trunk's landing policy through the project's real hooks. */
function landingPolicy(box, landing, message) {
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  const committed = box.tryGit(box.repo, 'commit', '-q', '-m', message);
  assert.equal(committed.status, 0, committed.stdout + committed.stderr);
}

test('the scheduled wake io lands one accepted item through landAfterAcceptance [B35,B3]', () => {
  const box = landProject();
  // The project holds landing while the item is accepted, so it waits accepted and unmerged for the wake, as a deferred landing does.
  assert.equal(JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')).landing?.manualOverride, true);
  const entry = itemWorktree(box, 1);
  submitItem(box, entry);
  acceptItem(box, entry);
  landingPolicy(box, { manualOverride: false }, 'chore: the board lands accepted items');
  const source = [
    `import { wakeIo } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../src/io/landing/automatic.js')).href)};`,
    `import { cli$context as context } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../index.js')).href)};`,
    `import { landAfterAcceptance } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../index.js')).href)};`,
    `import * as store from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../packages/store/index.js')).href)};`,
    `import { openBoard } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../lib/index.js')).href)};`,
    "import { join } from 'node:path';",
    'const [root, itemId] = process.argv.slice(1);',
    'let error = null;',
    'try { await landAfterAcceptance(context(wakeIo(root))); } catch (failure) { error = String(failure?.stack ?? failure); }',
    'const board = openBoard(join(root, ".git", "pullboard", "board.sqlite"));',
    'try { console.log("RESULT " + JSON.stringify({ error, merged: store.getItem(board, Number(itemId)).item_merged_commit })); } finally { store.closeBoard(board); }',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, String(entry.item)], { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  const result = JSON.parse(run.stdout.split('\n').find(line => line.startsWith('RESULT ')).slice('RESULT '.length));
  assert.equal(result.error, null, result.error);
  assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /io\.nativeBoardPorts is not a function/u);
  assert.ok(result.merged, `the accepted item lands: ${run.stdout}\n${run.stderr}`);
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), box.git(box.remote, 'rev-parse', 'main'), 'the landed main is published');
});

test('the wake io carries the board openers the relay path reads during a landing [B35]', () => {
  const io = wakeIo('/nonexistent-wake-root');
  assert.equal(typeof io.openBoard, 'function');
  // packages/link's relay sync and recovery read presentation and engine ports through io.nativeBoardPorts().
  const ports = io.nativeBoardPorts();
  assert.ok(ports.presentation, 'presentation ports for the relay path');
  assert.ok(ports.enginePorts, 'engine ports for the relay sender policy');
});
