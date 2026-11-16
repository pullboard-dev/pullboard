/** @pullboard-test-input source-cell apps/cli packages/config */
/** Every moves.live.* machine default has a switch row in pullboard moves, and every switch row names a real setting [C7,#9366]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIVE_SWITCH } from '../../../src/io/commands/moves.js';
import { movesReport } from '../../../src/io/commands/moves.js';
import { MACHINE_DEFAULTS } from '../../../../../packages/config/src/io/settings/machine-defaults.js';

/** The one switch value that is not a moves.live. key; it is a gate setting with its own default. */
const OUTSIDE_LIVE_KEYS = 'gate.fencedHop';

test('clause 1: every moves.live. machine default is a LIVE_SWITCH value, and every LIVE_SWITCH value but gate.fencedHop is a machine default [C7,#9366]', () => {
  const liveKeys = Object.keys(MACHINE_DEFAULTS).filter(key => key.startsWith('moves.live.'));
  assert.ok(liveKeys.length > 0, 'the machine defaults list at least one moves.live. key');
  const switches = new Set(Object.values(LIVE_SWITCH));
  for (const key of liveKeys) assert.ok(switches.has(key), `${key} has no switch row in pullboard moves`);
  for (const name of switches) {
    if (name === OUTSIDE_LIVE_KEYS) continue;
    assert.ok(Object.hasOwn(MACHINE_DEFAULTS, name), `${name} is named by a switch row but is not a machine default`);
  }
});

test('clause 2: a recorded table with no switch still lists with liveSwitch null and does not throw [C7,#9366]', () => {
  const shadows = { mystery: { compared: 3, disagreed: 0, since: '2026-11-15T12:00:00.000Z', lastDisagreedAt: null, last: [] } };
  const rows = movesReport(shadows, [], {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].table, 'mystery');
  assert.equal(rows[0].liveSwitch, null);
  assert.equal(rows[0].compared, 3);
});
