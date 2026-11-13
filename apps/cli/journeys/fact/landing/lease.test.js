/** @pullboard-test-input apps/cli/index.js apps/cli/src/io/landing/automatic.js apps/cli/tests/fixtures/child.js apps/lib/index.js packages/landing/index.js packages/store/index.js */
/** A landing that loses its lease mid-batch ends cleanly and the next wake adopts and lands its batch [C7,#5770]. */
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
import { onBoard } from '../../../tests/fixtures/land/board.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import * as store from '../../../../../packages/store/index.js';
import {
  scheduleAutomaticLanding,
  automaticLandingDirectory,
} from '../../../../../packages/landing/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

/** An import line for one repository module, by its path from this file. */
const from = (names, path) => `import { ${names} } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, path)).href)};`;

/**
 * One scheduled wake, run in its own process the way its timer starts it. In 'lose' mode the wake's real landing loses its
 * lease once its batch is recorded: the board's heartbeat for it is set in the past, as when renewals miss the deadline.
 */
const WAKE = [
  from('resumeAutomaticLanding, scheduleAutomaticLanding', '../../../../../packages/landing/index.js'),
  from('runLandingWake, wakeIo', '../../../src/io/landing/automatic.js'),
  from('context, landAfterAcceptance', '../../../index.js'),
  "import { DatabaseSync } from 'node:sqlite'; import { join } from 'node:path';",
  'const [root, dueAt, mode] = process.argv.slice(1);',
  'const boardFile = join(root, ".git/pullboard/board.sqlite");',
  'const schedule = async (actual, at, url, options = {}) => scheduleAutomaticLanding(actual, at, url, { ...options, schedule: async () => {} });',
  '/** Expire the landing heartbeat as soon as a batch is recorded and unfinished. */',
  'function loseLease() {',
  '  const timer = setInterval(() => {',
  '    const db = new DatabaseSync(boardFile); db.exec("PRAGMA busy_timeout = 5000");',
  '    try {',
  '      if (!db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind = \'landing_batch\'").get().n) return;',
  '      const rows = db.prepare("SELECT meta_key, meta_value FROM board_meta WHERE meta_key LIKE \'local:landing-lease:%\'").all();',
  '      for (const row of rows) db.prepare("UPDATE board_meta SET meta_value = ? WHERE meta_key = ?").run(JSON.stringify({ ...JSON.parse(row.meta_value), until: "2000-01-01T00:00:00.000Z" }), row.meta_key);',
  '      if (rows.length) { clearInterval(timer); console.log("LEASE EXPIRED"); }',
  '    } finally { db.close(); }',
  '  }, 20);',
  '  timer.unref();',
  '}',
  'const run = async actual => runLandingWake(actual, { land: async ctx => { if (mode === "lose") loseLease(); return landAfterAcceptance(ctx); }, wait: async () => {}, pollMs: 1 });',
  'await resumeAutomaticLanding(root, "fixture-token", dueAt, run, { wait: async () => true, schedule });',
  'process.exit(process.exitCode ?? 0);',
].join('\n');

/** Read the fixture's pending wake record. */
function pending(box) { return JSON.parse(readFileSync(join(automaticLandingDirectory(box.repo), 'pending.json'), 'utf8')); }

/** Run one wake child for the pending record and return its result. */
function wake(box, mode) {
  return runFixtureChild(process.execPath, ['--input-type=module', '-e', WAKE, box.repo, pending(box).dueAt, mode], { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
}

test('clause 1 and clause 2 (#5770): a wake whose landing loses its lease mid-batch logs it, keeps the batch and exits 0, and the next wake adopts the batch and lands it [C7]', { timeout: 300_000 }, async () => { // budget: two real landings in a private repo; hang ceiling only.
  const box = landProject();
  const entry = itemWorktree(box, 1);
  submitItem(box, entry);
  acceptItem(box, entry);
  // Automatic landing is turned on only after the accept, so the verdict itself starts no detached lander.
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { ...config.landing, manualOverride: false } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: the board lands accepted items');
  await scheduleAutomaticLanding(box.repo, new Date().toISOString(), new URL('../../../src/io/landing/automatic.js', import.meta.url), { schedule: async () => {} });

  const first = wake(box, 'lose');
  assert.equal(first.status, 0, `the lander exits 0 after a lost lease\n${first.stderr}\n${first.stdout}`);
  assert.match(first.stdout, /LEASE EXPIRED/u, 'the fixture expired the lease mid-batch');
  assert.match(first.stderr, /landing stopped \(LAND_LEASE_LOST\): .*; the next wake adopts its batch/u, 'the loss is logged');
  assert.doesNotMatch(first.stderr, /^\s+at /mu, 'no uncaught error stack');
  const left = onBoard(box, board => ({ batches: store.landingBatches(board), item: store.getItem(board, entry.item) }));
  const interrupted = left.batches.find(batch => !['landed', 'blocked'].includes(batch.state));
  assert.ok(interrupted, `the batch stays unfinished for adoption: ${JSON.stringify(left.batches.map(batch => batch.state))}`);
  assert.equal(left.item.item_merged_commit ?? null, null, 'nothing landed under the lost lease');
  const reload = pending(box);
  assert.equal(reload.running, undefined, 'the wake released its custody for the next one');
  assert.equal(reload.backoff, undefined, 'the next wake is due at once, not after a back-off');
  assert.equal(reload.error, undefined, 'the wake recorded no crash');

  const second = wake(box, 'adopt');
  assert.equal(second.status, 0, `${second.stderr}\n${second.stdout}`);
  assert.match(second.stdout + second.stderr, new RegExp(`landing adopts interrupted batch ${interrupted.id}`, 'u'), 'the next wake adopts the interrupted batch');
  const done = onBoard(box, board => ({ batch: store.landingBatches(board).findLast(batch => batch.id === interrupted.id), item: store.getItem(board, entry.item) }));
  assert.equal(done.batch.state, 'landed', 'the adopted batch lands');
  assert.ok(done.item.item_merged_commit, 'the accepted item reaches main');
});
