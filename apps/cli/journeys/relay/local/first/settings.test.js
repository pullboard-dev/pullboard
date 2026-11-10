/** The relay outbox defaults on for existing boards while preserving an explicit shared opt-out [H21]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { relayOutboxSetting } from '../../../../index.js';
import { settingsInventory } from '../../../../../../packages/config/index.js';
import { performanceCores } from '../../../../../../packages/gate/index.js';
import {
  defaultViewPort,
  DEFAULT_VIEW_PORT,
} from '../../../../../../packages/config/index.js';
import { createE2eHelpers } from '../../../../tests/fixtures/e2e.js';

/** Return the effective relay.outbox row from the production settings inventory. */
function relaySettingRow(root, env) {
  const previous = Object.fromEntries(['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME'].map(key => [key, process.env[key]]));
  try {
    process.env.PULLBOARD_HOME = env.PULLBOARD_HOME;
    process.env.PULLBOARD_MACHINE_HOME = env.PULLBOARD_MACHINE_HOME;
    return settingsInventory([{ root }], null, { performanceCores, defaultViewPort, DEFAULT_VIEW_PORT }).settings.find(row => row.scope === 'repo' && row.key === 'relay.outbox');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Commit one coordinator choice so both production readers see the same committed configuration. */
function commitRelayChoice(box, value) {
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.relay = { ...config.relay, outbox: value };
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure relay outbox');
}

test('an existing board defaults relay.outbox on, preserves explicit opt-out, and reads without rewriting config [H21]', t => {
  const helpers = createE2eHelpers();
  const box = helpers.project('true', undefined, { withWorktree: false });
  t.after(() => helpers.cleanup());
  const file = join(box.repo, 'pullboard.json');

  const legacyBytes = readFileSync(file);
  assert.equal(JSON.parse(legacyBytes).relay, undefined, 'the fixture represents an existing board without this setting');
  assert.equal(relayOutboxSetting(box.repo), true, 'an absent setting enables the outbox on an existing board');
  const legacyRow = relaySettingRow(box.repo, box.env);
  assert.equal(legacyRow.key, 'relay.outbox');
  assert.equal(legacyRow.scope, 'repo');
  assert.match(legacyRow.board, /^[0-9a-f]{32}$/u);
  assert.equal(legacyRow.root, box.repo);
  assert.equal(legacyRow.value, true);
  assert.equal(legacyRow.default, true);
  assert.equal(legacyRow.source, file);
  assert.equal(legacyRow.origin, 'default');
  assert.deepEqual(readFileSync(file), legacyBytes, 'resolving the default does not rewrite the committed project file');

  for (const [choice, expected] of [[true, true], [false, false]]) {
    commitRelayChoice(box, choice);
    const configuredBytes = readFileSync(file);
    assert.equal(relayOutboxSetting(box.repo), expected, `an explicit ${choice} setting is honored`);
    const row = relaySettingRow(box.repo, box.env);
    assert.equal(row.value, expected);
    assert.equal(row.default, true);
    assert.equal(row.origin, 'configured');
    assert.deepEqual(readFileSync(file), configuredBytes, 'reading the committed choice does not rewrite project config');
  }
});
