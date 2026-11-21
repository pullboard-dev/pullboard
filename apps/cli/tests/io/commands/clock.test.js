/** @pullboard-test-input apps/cli/src/io/commands/clock.js apps/cli/tests/fixtures/next/take.js */
/** pullboard clock runs one clock pass for the coordinator and prints each move it made; --dry-run --json prints the versioned document and writes no event [B4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';
import { coordinatorHelp } from '../../../src/logic/help/coordinator.js';

const MINUTE = 60_000;
const clockMoves = box => box.board.db.prepare("SELECT item_id, event_detail FROM event WHERE event_kind = 'clock_move' ORDER BY event_id").all();
const eventCount = box => box.board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n;

test('cli.io-commands-clock.one-pass: clause 1: pullboard clock runs one clock pass and prints the due item id, rule and move; a seat is refused COORDINATOR_ONLY [B4,C7]', async t => {
  const box = await fixture(t);
  const id = box.add('Ready and idle');
  box.advance(90 * MINUTE);
  const seat = await cli(box, box.seats.builder.path, ['clock']);
  assert.notEqual(seat.code, 0, 'a seat cannot run the clock pass');
  assert.match(seat.err + seat.out, /COORDINATOR_ONLY/u);
  assert.deepEqual(clockMoves(box), [], 'a refused pass records nothing');
  const done = await cli(box, box.root, ['clock']);
  assert.equal(done.code, 0, done.err || done.out);
  assert.equal(done.document.applied.length, 1, 'one move is applied');
  assert.equal(done.document.applied[0].item, id);
  assert.equal(done.document.applied[0].rule, 'ready');
  assert.equal(done.document.applied[0].move, 'alarm');
  const moves = clockMoves(box);
  assert.equal(moves.length, 1, 'one clock_move event is logged');
  assert.equal(moves[0].item_id, id);
  assert.match(coordinatorHelp, /pullboard clock \[--dry-run\] \[--json\]/u, 'help lists the command');
});

test('cli.io-commands-clock.dry-run-json: clause 2: pullboard clock --dry-run --json prints the versioned clockSweep document and writes no event [B4,C7]', async t => {
  const box = await fixture(t);
  const id = box.add('Ready and idle');
  box.advance(90 * MINUTE);
  const before = eventCount(box);
  const dry = await cli(box, box.root, ['clock', '--dry-run']);
  assert.equal(dry.code, 0, dry.err || dry.out);
  assert.equal(dry.document.version, 1);
  assert.equal(dry.document.dryRun, true);
  for (const list of ['applied', 'pending', 'waiting']) assert.ok(Array.isArray(dry.document[list]), `${list} is a list`);
  assert.deepEqual(dry.document.applied.map(row => row.item), [id], 'dry-run names the move it would make');
  assert.equal(eventCount(box), before, 'dry-run writes no event');
  assert.deepEqual(clockMoves(box), []);
});
