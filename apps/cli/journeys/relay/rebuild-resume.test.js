/** The relay outbox rebuild survives a stop at any step and resumes from its journal (#6728) [B26,H16,H17]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { watchRebuild } from '../../../../packages/outbox/index.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { joinFixtureSeat } from '../../../../packages/gate/tests/fixtures/testkit.js';
import {
  relayClientFixture,
  relayFixtureChild,
} from '../../tests/fixtures/relay/client.js';

const CLI = fileURLToPath(new URL('../../pullboard.js', import.meta.url));

/** Turn the board's committed relay.outbox setting on, as its coordinator would. */
function enableOutbox(box) {
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, relay: { outbox: true } }, null, 2) + '\n');
  // The board's own commit hook runs pullboard, so this private PATH gets the CLI under test.
  const cliPath = fileURLToPath(new URL('../../pullboard.js', import.meta.url));
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${cliPath}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore(config): queue relay moves while the relay is down'], { cwd: box.root, env: box.env });
}

/**
 * An agent seat on the other machine. Its moves are its own, so it adds while the first machine's main checkout
 * keeps the coordinator: one main checkout coordinates a board at a time (E19, #347).
 */
async function otherAgent(box, other) {
  const path = join(dirname(other.root), 'other-agent');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'agent/other', path], { cwd: other.root, env: other.env });
  /** Run the real CLI in the other machine's agent worktree. */
  const run = (...args) => relayFixtureChild(path, other.env, [CLI, ...args, '--json']);
  const joined = await joinFixtureSeat(box, path, box.lane, { run: (root, ...args) => relayFixtureChild(root, other.env, [CLI, ...args, '--json']) });
  assert.equal(joined.code, 0, joined.err);
  return run;
}

/** Two machines on one accepted relay board with the outbox on, and an item added before the outage. */
async function twoMachines(t, title, { beforeLink } = {}) {
  const box = await relayClientFixture(t);
  enableOutbox(box);
  await beforeLink?.(box);
  await box.link();
  const contested = (await box.cliLocal('add', box.lane, title)).document.item.item_id;
  const printed = await box.cliLocal('relay', 'pair');
  const other = await box.otherDeviceJoin(printed.document.code);
  assert.equal(JSON.parse(readFileSync(box.linkFile, 'utf8')).baselineAccepted, true, 'the relay accepted this board before the outage');
  return { box, other, contested };
}

/** Run `status` (which flushes the outbox) with the rebuild set to stop after `step` the first time it gets there; says whether it stopped. */
async function stopAfter(box, step) {
  let stopped = false;
  watchRebuild((reached) => { if (reached === step && !stopped) { stopped = true; throw new Error('stopped after ' + step); } });
  try { await box.cliLocal('status'); } catch (error) { if (!String(error?.message ?? error).includes('stopped after')) throw error; } finally { watchRebuild(null); }
  return stopped;
}

/** Offline moves queued behind a relay that then has another machine's work to replay first. */
async function queuedBehindRemoteWork(t) {
  const { box, other } = await twoMachines(t, 'Added before the outage');
  await box.stopRelay();
  await box.cliLocal('add', box.lane, 'First item added here offline');
  await box.cliLocal('add', box.lane, 'Second item added here offline');
  await box.restartRelay();
  const agent = await otherAgent(box, other);
  await agent('add', box.lane, 'Remote item ordered first');
  return { box, other };
}

/** Item titles read straight from the board file: a command, even a local one, would finish the stopped rebuild. */
function boardTitles(box) {
  const board = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  try { return board.prepare('SELECT item_title FROM item ORDER BY item_id').all().map((row) => row.item_title); } finally { board.close(); }
}

/** Item titles on a machine, in item order. */
async function titles(machine) {
  return (await machine.cli('export')).document.tables.item.map((row) => row.item_title);
}

test('clause 1: the outbox rebuild resumes from its last step after a stop at each step [B26,H16,H17]', { timeout: 280_000 }, async (t) => {
  const { box, other } = await queuedBehindRemoteWork(t);
  for (const step of ['undo', 'apply', 'settle', 'reapply', 'write']) {
    assert.equal(await stopAfter(box, step), true, `the rebuild reached ${step}`);
    const shown = boardTitles(box);
    // However far it got, this machine keeps showing its own queued moves once, never twice and never lost.
    assert.equal(shown.filter((title) => title === 'First item added here offline').length <= 1, true, `no row is undone twice after ${step}`);
  }
  const finished = await box.cliLocal('status');
  assert.equal(finished.code, 0, finished.failure);
  assert.equal(finished.document.relay.outbox, undefined, 'a restart finishes the rebuild and sends the tail');
  for (const machine of [box, other]) {
    const shown = await titles(machine);
    assert.deepEqual(shown.filter((title) => /offline|Remote item/.test(title)),
      ['Remote item ordered first', 'First item added here offline', 'Second item added here offline'],
      'acknowledged moves are applied once and the unsent tail keeps its order');
  }
});

test('clause 2: an outbox whose base is behind its own receipts is reconciled, not refused [B26,H16,H17]', { timeout: 280_000 }, async (t) => {
  const { box, other } = await queuedBehindRemoteWork(t);
  // Stop after the ordered records apply, then lose the rebuild's marker as a rebuild by an older version never wrote one.
  assert.equal(await stopAfter(box, 'apply'), true);
  const board = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  board.prepare("DELETE FROM board_meta WHERE meta_key LIKE 'relay\\_outbox\\_rebuild' ESCAPE '\\'").run();
  board.close();
  const finished = await box.cliLocal('status');
  assert.equal(finished.code, 0, finished.failure);
  assert.equal(finished.document.relay.outbox, undefined, 'the outbox is reconciled and its moves are sent');
  for (const machine of [box, other]) {
    const shown = await titles(machine);
    assert.deepEqual(shown.filter((title) => /offline|Remote item/.test(title)),
      ['Remote item ordered first', 'First item added here offline', 'Second item added here offline']);
  }
});
