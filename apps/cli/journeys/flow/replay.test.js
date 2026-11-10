/** The replay bench changes only scheduling, never recorded work or private text [R1,R2,A1]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { main } from '../../tests/fixtures/native.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';

const BASE = Date.parse('2026-10-20T00:00:00Z');
/** Exact fixture time, without depending on the machine's wall clock. */
function at(minutes) { return new Date(BASE + minutes * 60_000).toISOString(); }

/** Real Git and SQLite with stale open rows: the bench must follow only lifecycle history. */
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-replay-')));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: { web: { owns: ['web/'] } } }));
  writeFileSync(join(root, 'PRACTICE.md'), '');
  const seed = openBoard(join(root, '.git', 'seed.sqlite'));
  store.register(seed, { lane: 'coordinator', path: root });
  store.register(seed, { lane: 'web', path: join(root, 'b1') });
  store.register(seed, { lane: 'web', path: join(root, 'b2') });
  store.register(seed, { lane: 'review', path: join(root, 'r1') });
  for (let id = 1; id <= 2; id += 1) store.addItem(seed, { by: 'coordinator', lane: 'web', title: `PRIVATE_TITLE_TOKEN_${id}` });
  const document = exportBoard(seed);
  store.closeBoard(seed);
  const moves = [
    [0, 'coordinator', 'add', 1], [0, 'coordinator', 'add', 2],
    [1, 'web-2', 'claim', 2], [2, 'web-1', 'claim', 1],
    [3, 'web-2', 'submit', 2], [3, 'review-1', 'reserve', 2],
    [4, 'review-1', 'accept', 2], [7, 'coordinator', 'merged', 2],
    [7, 'web-1', 'submit', 1], [8, 'review-1', 'reserve', 1],
    [10, 'review-1', 'accept', 1], [14, 'coordinator', 'merged', 1],
  ];
  document.tables.event = moves.map(([minute, by, kind, item], index) => ({
    event_id: index + 1, event_at: at(minute), event_by: by, event_kind: kind, item_id: item,
    event_detail: JSON.stringify({ text: 'PRIVATE_EVENT_TOKEN', commit: 'SECRET_COMMIT_TOKEN' }),
  }));
  document.tables.sqlite_sequence.find(row => row.name === 'event').seq = moves.length;
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  importBoard(board, document);
  store.closeBoard(board);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Invoke the real CLI in-process, keeping refusal text when the command is missing. */
async function run(root, ...args) {
  let stdout = '', stderr = '';
  const code = await main(args, { cwd: root, stdout: { isTTY: false, write: text => { stdout += text; } },
    stderr: { write: text => { stderr += text; } } });
  return { code, stdout, stderr };
}

test('the replay bench reproduces a recorded history and is deterministic [R1,R2,A1]', async t => {
  const root = fixture(t);
  const original = await run(root, 'flow', 'replay', '--json');
  assert.equal(original.code, 0, `the replay command succeeds: ${original.stderr}${original.stdout}`);
  const recorded = JSON.parse(original.stdout);
  assert.deepEqual(recorded.replay.landingOrder, [2, 1]);
  assert.deepEqual(recorded.replay.items.map(item => [item.id, item.claimAt, item.landedAt, item.cycleMinutes]),
    [[1, at(2), at(14), 12], [2, at(1), at(7), 6]], 'recorded queue waits and each claim-to-landed time survive');
  assert.doesNotMatch(JSON.stringify(recorded.history), /PRIVATE_|SECRET_|event_detail|title|text|commit|path/u,
    'export only structural ids, event kinds and times, never descriptions, messages, commits or paths');
  const history = join(root, 'history.json');
  const policy = join(root, 'policy.json');
  writeFileSync(history, JSON.stringify(recorded.history));
  writeFileSync(policy, JSON.stringify({ order: [1, 2], settings: { wipPerReviewer: 1.5, landingBatchSize: 1, landingCadenceMinutes: 5 } }));
  const counterfactual = await run(root, 'flow', 'replay', '--history', history, '--policy', policy, '--json');
  assert.equal(counterfactual.code, 0, counterfactual.stderr + counterfactual.stdout);
  const changed = JSON.parse(counterfactual.stdout);
  assert.deepEqual(changed.replay.landingOrder, [1, 2]);
  assert.deepEqual(changed.replay.items.map(item => [item.id, item.cycleMinutes]), [[1, 11], [2, 8]]);
  assert.deepEqual(changed.replay.stages.build, { count: 2, fastQuarterMinutes: 2, medianMinutes: 3.5, slowQuarterMinutes: 5, worstMinutes: 5 });
  assert.deepEqual(changed.replay.stages.review, { count: 2, fastQuarterMinutes: 1, medianMinutes: 1.5, slowQuarterMinutes: 2, worstMinutes: 2 });
  assert.deepEqual(changed.replay.stages.mergeWait, { count: 2, fastQuarterMinutes: 4, medianMinutes: 4.5, slowQuarterMinutes: 5, worstMinutes: 5 });
  assert.equal((await run(root, 'flow', 'replay', '--history', history, '--policy', policy, '--json')).stdout,
    counterfactual.stdout, 'same structural input and policy produce byte-identical JSON');
});
