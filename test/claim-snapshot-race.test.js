/** @pullboard-test-input source-tree */
/** @pullboard-test-loads src/board.js src/cli/claim.js src/check-baseline-worker.js */
/** Native baseline completion must not strand a claim whose source remains valid [B2,C7,V2]. */
// Recovered unchanged from core-716's eacc75698b7 deterministic baseline-worker reproduction.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../src/board.js';
import { claimFreezer } from '../src/cli/claim.js';
import { context } from '../src/cli-context.js';
import { writeBoardCommand } from '../src/board-command-write.js';
import { prepareCheckBaseline } from '../src/check-baseline.js';
import { runFixtureChildAsync } from './fixture-child.js';
import { createE2eHelpers } from './e2e-helpers.js';

/** Wait for an owned fixture process to reach its explicit barrier, never a performance threshold. */
function until(read, label) {
  const deadline = Date.now() + 20_000;
  while (!read()) {
    assert.ok(Date.now() < deadline, label);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

test('a real baseline worker completes during claim preparation without stranding the claim [B2,C7,V2]', async t => {
  const e2e = createE2eHelpers();
  const box = e2e.project('true');
  const entered = join(box.dir, 'baseline-entered');
  const release = join(box.dir, 'baseline-release');
  let board;
  let peer;
  let worker;
  t.after(async () => {
    writeFileSync(release, 'release');
    if (worker) await worker;
    peer?.close();
    if (board) store.closeBoard(board);
    e2e.cleanup();
  });
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test', 'baseline.cjs'), [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(entered)}, String(process.pid));`,
    'const deadline = Date.now() + 20000;',
    `while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
    'process.exit(1);',
    '',
  ].join('\n'));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: record real baseline barrier');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file locking: the real worker must modify this persisted Git board during native claim preparation.
  board = store.openBoard(file, undefined, { gitRoot: box.web });
  peer = new DatabaseSync(file);
  peer.exec('PRAGMA busy_timeout=0');
  const command = 'node test/baseline.cjs';
  const expected = prepareCheckBaseline(box.repo, command);
  assert.equal(expected.result, 'pending');
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Baseline race', specIds: ['G1'],
    criterion: 'the actual baseline can finish before the native claim', check: command, checkBaseline: expected });
  // This is the actual production worker entry and argv, with an owned child handle so cleanup drains it.
  worker = runFixtureChildAsync(process.execPath, [join(import.meta.dirname, '../bin/check-baseline.js'),
    box.repo, String(id), expected.request], { cwd: box.repo, env: box.env });
  until(() => existsSync(entered), 'the actual baseline command reached its barrier');
  const agentId = store.agentAt(board, box.web).agent_id;
  const initial = store.getItem(board, id).item_check_baseline;
  assert.equal(initial.result, 'pending');
  const beforeEvents = store.events(board).at(-1).event_id;
  const freeze = claimFreezer(context({ cwd: box.web }), board);
  let calls = 0;
  let result;
  let failure;
  try {
    result = writeBoardCommand(board, 'claim', [id, { agentId, lane: 'web', leaseMs: 7_200_000,
      freeze(item) {
        calls++;
        peer.exec('BEGIN IMMEDIATE');
        peer.exec('ROLLBACK');
        const frozen = freeze(item);
        if (calls === 1) {
          writeFileSync(release, 'release');
          until(() => store.getItem(board, id).item_check_baseline.result === 'red',
            'the actual detached worker recorded its real red result');
        }
        return frozen;
      },
    }], agentId);
  } catch (error) { failure = error; }
  const terminal = await worker;
  assert.equal(terminal.status, 0, terminal.failure);
  const baseline = store.getItem(board, id).item_check_baseline;
  assert.equal(baseline.result, 'red');
  assert.equal(baseline.request, initial.request);
  const completions = store.events(board).filter(event => event.event_id > beforeEvents && event.event_kind === 'check-baseline');
  assert.equal(completions.length, 1, 'the real second-process writer is the baseline completion');
  assert.equal(completions[0].event_by, 'coordinator');
  assert.equal(JSON.parse(completions[0].event_detail).checkBaseline.request, initial.request);
  assert.equal(failure, undefined, failure?.stack);
  assert.equal(result.renewed, false);
  assert.equal(store.getItem(board, id).item_owner, agentId);
  assert.equal(store.events(board).filter(event => event.event_kind === 'claim').length, 1);
  assert.equal(calls, 2, 'fresh preparation excludes the completed writer and remains outside BEGIN');
});
