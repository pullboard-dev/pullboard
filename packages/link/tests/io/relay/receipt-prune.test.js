/** @pullboard-test-input source-cell link */
/** With relay.pruneReceipts on, a request receipt older than 7 days is dropped and a legacy untimed receipt stays [C7,#9337]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { keptReceipts } from '../../../src/io/relay/requests.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const DAY = 86_400_000;
const board = { clock: { now: () => new Date(NOW) } };
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const RECORDS = [{ id: 'old', at: ago(8) }, { id: 'recent', at: ago(6) }, { id: 'legacy' }, { id: 'garbled', at: 'not a time' }];

/** Run `body` with a private machine home holding `settings`, restoring the home afterwards. */
function withSettings(settings, body) {
  const { root } = privateFixtureFiles('pullboard-receipt-prune-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return body();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

const ids = (records) => records.map((record) => record.id);

test('link.receipt-prune.drops-old-keeps-recent: clause 1: with relay.pruneReceipts on and a fake clock, a receipt from 8 days ago is gone and one from 6 days ago stays [C7,#9337]', () => {
  const kept = withSettings({ relay: { pruneReceipts: true } }, () => keptReceipts(board, RECORDS));
  assert.equal(ids(kept).includes('old'), false);
  assert.equal(ids(kept).includes('recent'), true);
});

test('link.receipt-prune.legacy-and-off-keep: clause 2: a legacy receipt with no recorded time stays, and with the setting off nothing is dropped [C7,#9337]', () => {
  const on = withSettings({ relay: { pruneReceipts: true } }, () => keptReceipts(board, RECORDS));
  assert.deepEqual(ids(on), ['recent', 'legacy', 'garbled']);
  const off = withSettings({}, () => keptReceipts(board, RECORDS));
  assert.deepEqual(ids(off), ids(RECORDS));
});
