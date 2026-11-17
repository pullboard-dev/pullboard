/** @pullboard-test-input source-cell apps/cli */
/** pullboard moves lists every table a live switch governs, so a shadowed writer that never recorded a compare shows at 0 [C7,#10493]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIVE_SWITCH } from '../../../src/io/commands/moves.js';
import { movesReport } from '../../../src/io/commands/moves.js';
import { moveTableNames } from '../../../src/io/commands/moves.js';

/** Table files as the moves cell has them: none named start or complete. */
const PATHS = ['backbone', 'claim', 'hop', 'job', 'landing', 'lease', 'outbox', 'pulled', 'reclaim', 'release', 'reopen', 'submit', 'verify', 'withdraw']
  .map(name => `packages/moves/src/logic/table/${name}.table.js`);
const row = (rows, table) => rows.find(entry => entry.table === table);

test('clause 1: with no start or complete file and nothing recorded, start and complete list as none, 0 compares, under moves.live.handoff [C7]', () => {
  const rows = movesReport({}, moveTableNames(PATHS), {});
  for (const table of ['start', 'complete']) {
    const found = row(rows, table);
    assert.ok(found, `${table} is listed`);
    assert.deepEqual([found.state, found.compared, found.liveSwitch], ['none', 0, 'moves.live.handoff']);
  }
});

test('clause 2: start and complete read live with moves.live.handoff on, and every LIVE_SWITCH key is listed exactly once [C7]', () => {
  const rows = movesReport({}, moveTableNames(PATHS), { moves: { live: { handoff: true } } });
  assert.deepEqual(['start', 'complete'].map(table => row(rows, table).state), ['live', 'live']);
  for (const table of Object.keys(LIVE_SWITCH)) assert.equal(rows.filter(entry => entry.table === table).length, 1, `${table} listed once`);
});
