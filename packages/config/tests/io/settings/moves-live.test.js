/** The moves.live machine settings: six tables default on, hand-off and outbox default off, and each can still be set either way [C7,#8395]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { MACHINE_DEFAULTS } from '../../../index.js';
import { movesLiveEnabled } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

const ON = ['claim', 'job', 'outcome', 'reclaim', 'reopen', 'submit'];
const OFF = ['handoff', 'outbox'];

/** What movesLiveEnabled reads for a table in a private machine home holding the given settings, restoring the home afterwards. */
function liveWith(table, settings) {
  const { root: dir } = privateFixtureFiles('pullboard-moves-live-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return movesLiveEnabled(table);
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.io-settings-moves-live.claim-submit-outcome-job-reopen-reclaim-default-on: clause 1: moves.live claim, submit, outcome, job, reopen and reclaim default on and handoff and outbox default off [C7,#8395]', () => {
  for (const table of ON) {
    assert.equal(MACHINE_DEFAULTS['moves.live.' + table], true, table);
    assert.equal(liveWith(table, {}), true, table);
  }
  for (const table of OFF) {
    assert.equal(MACHINE_DEFAULTS['moves.live.' + table], false, table);
    assert.equal(liveWith(table, {}), false, table);
  }
});

test('config.io-settings-moves-live.each-table-can-still-be-set-either-way: clause 2: each moves.live table can still be set either way, and an exact setting wins over its default [C7,#8395]', () => {
  for (const table of ON) assert.equal(liveWith(table, { moves: { live: { [table]: false } } }), false, table);
  for (const table of OFF) assert.equal(liveWith(table, { moves: { live: { [table]: true } } }), true, table);
  for (const table of ON) assert.equal(liveWith(table, { moves: { live: { [table]: true } } }), true, table);
});
