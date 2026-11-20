/** @pullboard-test-input apps/cli/src/io/read.js */
/** Only a write whose outcome depends on accepted main pins main's policy snapshot [C7,B2]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../fixtures/e2e.js';
import { openKitBoard } from '../fixtures/board.js';
import { fixtureOpenBoard } from '../fixtures/board.js';
import { withFixtureBoard } from '../fixtures/board.js';
import { atomic } from '../../../../packages/store/index.js';
import { boardFilePath } from '../../../../packages/store/index.js';
import { closeBoard } from '../../../../packages/store/index.js';
import {
  itemLine,
  withOpenedBoard,
} from '../../src/io/read.js';
import { fileFixtureItem } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { repoInfo } from '../../../../packages/git/index.js';

/** Block this thread, as a slow write does while holding the writer. */
function hold(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** One real repo and one file board path; each write opens it through the kit, since a command closes its board. */
function setup(t) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const directory = join(box.repo, '.git', 'policy-moving-main-test');
  mkdirSync(directory);
  const file = join(directory, 'board.sqlite');
  const ref = box.git(box.repo, 'symbolic-ref', 'HEAD').trim();
  return { box, file, ref };
}

/** A context for one named CLI command, as the CLI entry records it. */
function commandContext(box, command) {
  return { info: repoInfo(box.repo), io: { relayCommand: { cliOperation: command, positionals: [], values: {} } } };
}

/** Move main with a real empty commit every 500 ms from another process until stopped. */
function moveMainEvery500ms(t, repo) {
  const loop = 'while :; do git -C "$1" commit -q --allow-empty --no-verify -m "chore: lander moves main" >/dev/null 2>&1; sleep 0.5; done';
  const child = spawn('/bin/sh', ['-c', loop, 'mover', repo], { stdio: 'ignore' });
  const stop = () => { if (child.exitCode === null && !child.killed) child.kill(); };
  t.after(stop);
  return stop;
}

test('cli.io-read.claim-commits-every-write-while-main-moves: claim commits every write while main moves every 500 ms [C7,B2]', t => {
  const { box, file, ref } = setup(t);
  const stop = moveMainEvery500ms(t, box.repo);
  const tip = () => box.git(box.repo, 'rev-parse', ref).trim();
  const start = tip();
  let committed = 0;
  try {
    for (let write = 0; write < 3; write++) {
      withOpenedBoard(commandContext(box, 'claim'), opened => atomic(opened, () => {
        opened.db.prepare('INSERT INTO agent(agent_id,agent_lane,agent_path,agent_created_at) VALUES(?,?,?,?)')
          .run(`moving-main-seat-${write}`, 'core', `/fixture/moving-${write}`, '2026-11-12T00:00:00Z');
        hold(1200); // At least two lander moves land inside this one write.
      }), openKitBoard(file));
      committed++;
    }
  } finally { stop(); }
  assert.equal(committed, 3);
  assert.notEqual(tip(), start, 'main really moved while claim ran');
  withFixtureBoard(file, check => assert.equal(
    check.db.prepare("SELECT COUNT(*) AS n FROM agent WHERE agent_id LIKE 'moving-main-seat-%'").get().n, 3));
});

test('cli.io-read.a-main-dependent-submit-still-refuses-policy: a main-dependent submit still refuses POLICY_SNAPSHOT_STALE naming the moved ref [C7,B2]', t => {
  const { box, file, ref } = setup(t);
  let work = 0;
  assert.throws(() => withOpenedBoard(commandContext(box, 'submit'), opened => atomic(opened, () => {
    work++;
    box.git(box.repo, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'chore: lander moves main');
  }), openKitBoard(file)), error => error.code === 'POLICY_SNAPSHOT_STALE' && error.message.includes(`${ref} moved`));
  assert.equal(work, 1, 'the refused write is not replayed');
});

const WAITING = { item_id: 7, item_status: 'open', item_lane: 'web', item_title: 'Wait', item_route: 'strong', item_after: ['host#41'] };

test('cli.io-read.item-line-prints-foreign-state: itemLine with a foreign states map prints the state of a foreign wait, the cause of an unavailable one, and a local wait as before [C7,#11044,#11050]', () => {
  assert.match(itemLine(WAITING, id => id, false, new Map([['host#41', { status: 'verified' }]])), /after host#41 \(verified on host\)/u);
  assert.match(itemLine(WAITING, id => id, false, new Map([['host#41', { status: 'unavailable', cause: 'no link' }]])), /after host#41 \(unavailable: no link\)/u);
  assert.match(itemLine(WAITING), /after host#41$/u, 'without a map the label prints as before');
  assert.match(itemLine({ ...WAITING, item_after: [3] }, id => id, false, new Map([['host#41', { status: 'verified' }]])), /after #3$/u, 'a local wait prints as before');
});

test('cli.io-read.item-line-prints-foreign-age: clause 1: itemLine prints after host#41 (verified on host, 2 min ago) for a state received two minutes before the injected now, and no age for a state with no receivedAt [C7,#11044,#11367]', () => {
  const now = new Date('2026-11-19T10:02:00.000Z');
  const received = new Map([['host#41', { status: 'verified', receivedAt: '2026-11-19T10:00:00.000Z' }]]);
  assert.match(itemLine(WAITING, id => id, false, received, now), /after host#41 \(verified on host, 2 min ago\)$/u);
  assert.match(itemLine(WAITING, id => id, false, new Map([['host#41', { status: 'verified' }]]), now), /after host#41 \(verified on host\)$/u, 'no receivedAt prints no age');
  assert.match(itemLine(WAITING, id => id, false, received), /after host#41 \(verified on host\)$/u, 'no clock prints no age');
});

test('cli.io-read.show-prints-foreign-state: pullboard show on an item filed with --after host#41 prints that wait with its state on its first line [C7,#11044,#11050]', async t => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const item = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Waits on host', run: box.runLocal });
  // add refuses a wait on an unlinked repository now [XB1,#11040], so this wait is one filed before the guard, set straight on the row.
  const board = fixtureOpenBoard({ boardFile: boardFilePath(join(box.repo, '.git')), web: box.repo });
  try { board.db.prepare('UPDATE item SET item_after=? WHERE item_id=?').run('host#41', item.item_id); } finally { closeBoard(board); }
  const shown = await box.runLocal(box.repo, 'show', String(item.item_id));
  assert.equal(shown.code, 0, `${shown.err}\n${shown.out}`);
  assert.match(shown.out.split('\n')[0], /after host#41 \(unavailable: no link\)/u);
});

const MERGED = 'a1b2c3d4e5f60718293a4b5c6d7e8f901234567';
const ROW = { item_id: 7, item_lane: 'core', item_title: 'A title', item_route: 'strong' };

test('cli.io-read.itemline-landed-names-main-sha: clause 1: itemLine for a withdrawn item at stage landed with a merged commit prints on main at the first 12 characters, and no longer prints (landed) [C7,#11113]', () => {
  const line = itemLine({ ...ROW, item_status: 'withdrawn', item_stage: 'landed', item_merged_commit: MERGED });
  assert.equal(line, '#7  withdrawn (on main at a1b2c3d4e5f6)  core  A title');
  assert.doesNotMatch(line, /\(landed\)/u);
});

test('cli.io-read.itemline-withdrawn-unmerged-unchanged: clause 2: itemLine for a withdrawn item with no merged commit, and for a verified item, prints the same line as before [C7,#11113]', () => {
  assert.equal(itemLine({ ...ROW, item_status: 'withdrawn', item_stage: 'withdrawn' }), '#7  withdrawn  core  A title');
  assert.equal(itemLine({ ...ROW, item_status: 'withdrawn', item_stage: 'landed' }), '#7  withdrawn (landed)  core  A title');
  assert.equal(itemLine({ ...ROW, item_status: 'verified', item_stage: 'landed', item_verified_by: 'core-1', item_merged_commit: MERGED }), '#7  verified (landed) by core-1  core  A title');
});
