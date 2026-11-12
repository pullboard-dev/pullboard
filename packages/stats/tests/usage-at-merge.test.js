/** A merge or a withdrawal closes the usage of the seat that held the item, even with no submit or release [N2]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkpointAfterMove } from '../index.js';
import * as store from '../../store/index.js';
import { cellBoard } from '../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../store/tests/fixtures/cell.js';
import { cellItem } from '../../store/tests/fixtures/cell.js';
import { cellProject } from '../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../store/tests/fixtures/cell.js';

/** The model name store fixtures seat with. */
const FIXTURE_MODEL = 'Fixture Model';
const START = Date.parse('2026-11-09T12:00:00.000Z');
const MINUTE = 60_000;

/** A real repository and board, a seat, a movable clock and a synthetic native session whose counters the test appends. */
function fixture(t) {
  const project = cellProject(t);
  let at = START;
  const clock = { now: () => new Date(at) };
  const board = cellBoard(t, project.boardFile, clock, { gitRoot: project.repo });
  const seat = cellSeat(board, { lane: 'web', path: project.repo });
  const errors = [];
  const ctx = { info: { root: project.repo, commonDir: join(project.repo, '.git') }, clock, io: { err: (line) => errors.push(line) } };
  const environment = { CODEX_HOME: join(project.dir, 'codex'), CODEX_THREAD_ID: 'synthetic-usage-at-merge' };
  const directory = join(environment.CODEX_HOME, 'sessions');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'rollout-synthetic-usage-at-merge.jsonl');
  // One named model keeps every token and the wall time on a single record.
  writeFileSync(file, JSON.stringify({ type: 'turn_context', payload: { model: FIXTURE_MODEL } }) + '\n');
  /** Append one cumulative native counter row stamped at the fixture clock plus an offset. */
  const counter = (input, output, offset = 0) => appendFileSync(file, JSON.stringify({ timestamp: new Date(at + offset).toISOString(), type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output } } } }) + '\n');
  /** The command layer's ordered move, reduced to the board write it performs. */
  const ordered = async (_ctx, target, operation, args) => store[operation](target, ...args);
  const item = (title) => cellItem(board, { lane: 'web', title, specIds: ['G1'], route: 'strong', criterion: 'the fixture works' }).item_id;
  /** Claim as the seat does, then record the claim's checkpoint. */
  const claim = async (id) => {
    cellClaim(board, id, seat, { root: project.repo, itemFolder: true });
    await checkpointAfterMove(ctx, board, { agent: seat.id, item: id, operation: 'claim' }, { ordered, environment });
  };
  /** Close an item the way the coordinator's command layer does, from a shell that has no session of the seat. */
  const close = async (operation, id) => {
    if (operation === 'merged') store.merged(board, id, { agentId: 'coordinator', commit: project.git(project.repo, 'rev-parse', 'HEAD'), forced: 'landed by hand around the gate' });
    else store.withdraw(board, id, { agentId: 'coordinator', reason: 'withdrawn with unfinished work' });
    await checkpointAfterMove(ctx, board, { agent: 'coordinator', item: id, operation }, { ordered, environment: {} });
  };
  /** The shared cost row of one seat and item, or undefined. */
  const row = (id) => {
    const found = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`cost:${id}:${seat.id}`);
    return found && JSON.parse(found.meta_value);
  };
  const usageEvents = (id) => board.db.prepare("SELECT event_by, event_detail FROM event WHERE event_kind='usage'").all()
    .map((value) => ({ by: value.event_by, ...JSON.parse(value.event_detail) })).filter((value) => value.item === id);
  return { board, seat, errors, counter, claim, close, row, usageEvents, item, advance: (minutes) => { at += minutes * MINUTE; } };
}

test('a forced merge of a claimed item with no submit writes its cost row and usage event [N2]', async (t) => {
  const run = fixture(t);
  const id = run.item('Claimed then landed by hand');
  run.counter(10, 1, -MINUTE);
  await run.claim(id);
  assert.equal(run.row(id), undefined, 'a claim only opens its anchor, so nothing is shared before the item closes');
  run.advance(5);
  run.counter(37, 6);
  run.advance(5);
  await run.close('merged', id);
  const shared = run.row(id);
  assert.ok(shared, 'the merge published the claim holder usage');
  assert.equal(shared.agent, run.seat.id);
  assert.equal(shared.records.length, 1);
  assert.equal(shared.records[0].inputTokens, 27);
  assert.equal(shared.records[0].outputTokens, 5);
  assert.equal(shared.records[0].wallMs, 10 * MINUTE);
  const [event] = run.usageEvents(id);
  assert.equal(event.by, run.seat.id);
  assert.equal(event.revision, shared.revision);
  assert.deepEqual(run.errors, []);
});

test('two items claimed by one seat each get their own cost row [N2]', async (t) => {
  const run = fixture(t);
  const first = run.item('First claimed item'), second = run.item('Second claimed item');
  run.counter(10, 1, -MINUTE);
  await run.claim(first);
  run.advance(2);
  run.counter(30, 3);
  await run.claim(second);
  run.advance(2);
  run.counter(50, 8);
  run.advance(2);
  await run.close('merged', second);
  assert.equal(run.row(first).records[0].inputTokens, 20);
  assert.equal(run.row(first).records[0].outputTokens, 2);
  assert.equal(run.row(second).records[0].inputTokens, 20);
  assert.equal(run.row(second).records[0].outputTokens, 5);
  assert.equal(run.usageEvents(second).length, 1);
  await run.close('merged', first);
  assert.equal(run.row(first).records[0].inputTokens, 20, 'a later merge of the first item adds nothing to a closed anchor');
  assert.deepEqual(run.errors, []);
});

test('a withdrawal of a claimed item records the usage its last holder had [N2]', async (t) => {
  const run = fixture(t);
  const id = run.item('Claimed then withdrawn');
  run.counter(10, 1, -MINUTE);
  await run.claim(id);
  run.advance(4);
  run.counter(25, 4);
  run.advance(1);
  await run.close('withdraw', id);
  assert.equal(run.row(id).records[0].inputTokens, 15);
  assert.equal(run.row(id).records[0].outputTokens, 3);
  assert.equal(run.usageEvents(id).length, 1);
  assert.deepEqual(run.errors, []);
});
