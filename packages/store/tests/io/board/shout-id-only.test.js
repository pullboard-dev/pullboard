/** @pullboard-test-input source-cell store */
/** With board.compactShouts on, a shout event keeps the shout id and the thread reads the text from the shout table [C7,#9336]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

// fixture-subject: addItem (a store unit test over a stand-in board; the machine home holds the one setting under test)

/** Run `body` with a private machine home whose settings are `settings`, restoring the home afterwards. */
function withSettings(settings, body) {
  const { root } = privateFixtureFiles('pullboard-compact-shouts-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return body();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** A board with one item and the shout about it written under `settings`, with the event kept inline when asked. */
function shoutAbout(t, settings, text) {
  let at = Date.parse('2026-11-16T00:00:00.000Z');
  const board = cellBoard(t, ':memory:', { now: () => new Date(at += 1000) }, { real: false });
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const item = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'one', criterion: 'one works' });
  const id = withSettings(settings, () => store.shout(board, { from: 'coordinator', to: 'web', item, text, lanes: ['web'] }));
  const event = board.db.prepare("SELECT event_detail FROM event WHERE event_kind = 'shout' AND json_extract(event_detail, '$.shout') = ?").get(id);
  return { board, item, id, detail: JSON.parse(event.event_detail) };
}

test('clause 1: with board.compactShouts on, the event holds the shout id and no text, and the thread reads the same text from the shout table [C7,#9336]', t => {
  const { board, item, id, detail } = shoutAbout(t, { board: { compactShouts: true } }, 'Land the web slice first.');
  assert.equal(detail.shout, id);
  assert.equal('text' in detail, false, 'the event carries no text');
  const entry = store.itemThread(board, item).find(move => move.kind === 'shout');
  assert.equal(entry.detail.text, 'Land the web slice first.');
});

test('clause 2: an event written with the text inline reads the same text, and with the setting off the event keeps it [C7,#9336]', t => {
  const { board, item, detail } = shoutAbout(t, {}, 'Land the web slice first.');
  assert.equal(detail.text, 'Land the web slice first.', 'off by default: the event keeps the text');
  const entry = store.itemThread(board, item).find(move => move.kind === 'shout');
  assert.equal(entry.detail.text, 'Land the web slice first.');
});
