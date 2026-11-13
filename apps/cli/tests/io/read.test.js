/** @pullboard-test-input apps/cli/src/io/read.js */
/** Only a write whose outcome depends on accepted main pins main's policy snapshot [C7,B2]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../fixtures/e2e.js';
import { openKitBoard } from '../fixtures/testkit.js';
import { withFixtureBoard } from '../fixtures/testkit.js';
import { atomic } from '../../../../packages/store/index.js';
import { withOpenedBoard } from '../../src/io/read.js';
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

test('claim commits every write while main moves every 500 ms [C7,B2]', t => {
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

test('a main-dependent submit still refuses POLICY_SNAPSHOT_STALE naming the moved ref [C7,B2]', t => {
  const { box, file, ref } = setup(t);
  let work = 0;
  assert.throws(() => withOpenedBoard(commandContext(box, 'submit'), opened => atomic(opened, () => {
    work++;
    box.git(box.repo, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'chore: lander moves main');
  }), openKitBoard(file)), error => error.code === 'POLICY_SNAPSHOT_STALE' && error.message.includes(`${ref} moved`));
  assert.equal(work, 1, 'the refused write is not replayed');
});
