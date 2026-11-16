/** @pullboard-test-boundary contract */
/** The submit gate replays a changed move table and is red on any disagreement, naming each event [C7,#8073]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { changedTables } from '../../../src/io/moves/replay.js';
import { replayChangedTables } from '../../../src/io/moves/replay.js';

/** A stand-in board file the replay reader is never asked to open, since the report function is the test's own. */
function boardBox() {
  const box = privateFixtureFiles('pullboard-gate-replay-');
  box.write('board.sqlite', '');
  return join(box.root, 'board.sqlite');
}

/** A replay that records what it was asked and reports the given disagreeing events per table. */
function fakeReplay(byTable, calls) {
  return async ({ name, boardFile }) => {
    calls.push({ name, boardFile });
    const events = byTable[name] ?? [];
    return { table: name, total: 10, agreed: 10 - events.length, disagreed: events.length, disagreements: events.map(event => ({ event })) };
  };
}

test('clause 1: a diff that changes a move table replays that table [C7,#8073]', async () => {
  const boardFile = boardBox();
  const calls = [];
  const rows = await replayChangedTables('/unused', { changed: ['packages/moves/src/logic/table/backbone.table.js', 'README.md'], boardFile, replay: fakeReplay({}, calls) });
  assert.deepEqual(calls.map(call => call.name), ['backbone']);
  assert.equal(calls[0].boardFile, boardFile);
  assert.deepEqual(rows, [{ table: 'backbone', total: 10, agreed: 10, disagreed: 0 }]);
});

test('clause 2: a disagreement is a TABLE_REPLAY refusal naming each disagreeing event id [C7,#8073]', async () => {
  const boardFile = boardBox();
  await assert.rejects(
    replayChangedTables('/unused', { changed: ['a/hop.table.js'], boardFile, replay: fakeReplay({ hop: [4412, 4420] }, []) }),
    error => error.code === 'TABLE_REPLAY' && /hop disagrees with the board on 2 recorded moves \(event 4412, 4420\)/u.test(error.message) && /pullboard replay hop/u.test(error.next ?? error.message));
});

test('clause 3: a diff that changes no move table runs no replay [C7,#8073]', async () => {
  const boardFile = boardBox();
  const calls = [];
  assert.deepEqual(changedTables(['packages/gate/src/io/submit.js', 'docs/table.js.md']), []);
  assert.deepEqual(await replayChangedTables('/unused', { changed: ['packages/gate/src/io/submit.js'], boardFile, replay: fakeReplay({ hop: [1] }, calls) }), []);
  assert.equal(calls.length, 0);
});
