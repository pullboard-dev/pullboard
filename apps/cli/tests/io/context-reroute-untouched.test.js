/** @pullboard-test-input source-cell apps/cli */
/** The CLI board context carries release.rerouteUntouched onto the board it opens, off unless the setting is on [C7,#2970]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { withBoard } from '../../src/io/context.js';
import { fixture } from '../fixtures/next/take.js';

/** Open a stand-in board through the CLI context (the fixture isolates the machine settings) with the machine setting as given, and read what the context set on it. */
async function rerouteUntouched(t, setting) {
  const box = await fixture(t);
  const file = machineSettingsFile();
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify(setting === undefined ? settings : { ...settings, release: { rerouteUntouched: setting } }));
  const ctx = { file: box.file, clock: box.clock, config: box.config, io: {}, allowSchemaUpgrade: false, info: { root: box.root, isMain: true },
    // A stand-in board: the context only sets plain fields on it and closes its connection; nothing here reads the database.
    nativeBoard: { openBoard: () => ({ db: { close() {} } }) } };
  return withBoard(ctx, board => board.rerouteUntouched);
}

test('clause 1: a board opened by the CLI context has rerouteUntouched true with release.rerouteUntouched on [C7,#2970]', async t => {
  assert.equal(await rerouteUntouched(t, true), true);
});

test('clause 2: the same board has rerouteUntouched false with the setting off or unset [C7,#2970]', async t => {
  assert.equal(await rerouteUntouched(t, false), false);
  assert.equal(await rerouteUntouched(t, undefined), false);
});
