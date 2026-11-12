/** A seat holds up to N live build claims, N sized by the board from free test-run slots per live seat [C7]. */
import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../../../packages/config/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixturePolicy } from '../../tests/fixtures/testkit.js';
import { cellBoard } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellItem } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../packages/store/tests/fixtures/cell.js';

const e2e = createE2eHelpers();

/** A real repository, its board on a fixed clock, and web seats that heartbeat so they read as live. */
function fixture(t, { seats = 1 } = {}) {
  const repo = cellRepo(t);
  const at = Date.now() + 60_000;
  const board = cellBoard(t, ':memory:', { now: () => new Date(at) }, { gitRoot: repo.root });
  cellSeat(board, { lane: 'coordinator', path: repo.root });
  const ids = Array.from({ length: seats }, (_, index) => cellSeat(board, { lane: 'web', path: join(repo.root, `seat-${index}`) }));
  for (const seat of ids) heartbeatSeat(board, seat.id);
  const add = () => cellItem(board, { lane: 'web', title: 'Work', criterion: 'Real proof', specIds: ['G1'], route: 'strong', check: 'true' }).item_id;
  const claim = id => cellClaim(board, id, ids[0], { root: repo.root, itemFolder: true });
  return { board, add, claim, at };
}

/** Claim fresh items until the guard refuses; return how many were held and the refusal. */
function fill(f) {
  for (let held = 0; held < 10; held++) {
    const id = f.add();
    try { f.claim(id); } catch (error) { return { held, error }; }
  }
  return { held: 10, error: null };
}

test('claims.perSeat sets N: a seat holds N live claims and the next refuses ONE_CLAIM naming N [C7]', async () => {
  const box = e2e.project();
  fixturePolicy(box, { claims: { releaseGone: false, releaseCooldownMinutes: 30, perSeat: 2 } });
  box.git(box.web, 'merge', '-q', 'main');
  const ids = ['One', 'Two', 'Three'].map(title => {
    const added = fixtureAdd(box.run, box.repo, 'web', title, '--specs', 'G1', '--json');
    assert.equal(added.code, 0, added.err || added.out);
    return String(JSON.parse(added.out).item.item_id);
  });
  for (const id of ids.slice(0, 2)) {
    const claimed = await box.inProcess(box.web, 'claim', id);
    assert.equal(claimed.code, 0, claimed.err || claimed.out);
  }
  assert.equal(loadConfig(box.web).claims.perSeat, 2, 'the seat reads the setting');
  const refused = await box.inProcess(box.web, 'claim', ids[2]);
  assert.notEqual(refused.code, 0, `the third claim is refused: ${refused.out}\n${refused.err}\n${JSON.stringify(loadConfig(box.web).claims)} ${box.git(box.web, 'log', '--oneline', '-3')}`);
  const text = refused.err + refused.out;
  assert.match(text, /ONE_CLAIM/u);
  assert.match(text, /a seat holds up to 2 \(claims\.perSeat sets 2\)/u, 'the refusal names N and says where it came from');
});

test('with no runner, N is clamp(1, 5, local cores / live seats), at least 2 for one live seat [C7]', t => {
  const f = fixture(t, { seats: 1 });
  const cores = availableParallelism();
  const expected = Math.min(5, Math.max(1, cores));
  const { held, error } = fill(f);
  assert.equal(held, expected, 'the seat holds what the board measure allows');
  assert.ok(held >= 2 || cores < 2, 'one live seat on a machine with spare cores holds at least two claims');
  assert.equal(error.code, 'ONE_CLAIM');
  assert.ok(error.message.includes(`floor(${cores} free local cores / 1 live seats)) = ${expected}`), error.message);
});

test('live seats share the slots: more seats give each seat fewer claims, never below one [C7]', t => {
  const cores = availableParallelism();
  const f = fixture(t, { seats: cores + 1 });
  const { held, error } = fill(f);
  assert.equal(held, 1, 'more live seats than cores leaves each seat one claim');
  assert.ok(error.message.includes(`/ ${cores + 1} live seats)) = 1`), error.message);
});

test('a registered runner\'s free job slots stand in for local cores [C7]', t => {
  const f = fixture(t, { seats: 2 });
  // A pull runner that claimed recently declared 9 jobs; one job is live, so 8 slots are free for 2 live seats.
  f.board.db.prepare("INSERT INTO job (job_id, job_kind, job_step, job_lease_owner, job_lease_until, job_created, job_updated) VALUES ('j1', 'gate', 'running', 'runner-a', ?, ?, ?)").run(f.at + 600_000, f.at, f.at);
  f.board.db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES ('j1', 'claimed', ?, ?)").run(JSON.stringify({ runner: 'runner-a', jobs: 9 }), f.at - 1000);
  const { held, error } = fill(f);
  assert.equal(held, 4, 'floor(8 / 2) = 4');
  assert.ok(error.message.includes('floor(8 free runner slots / 2 live seats)) = 4'), error.message);
});
