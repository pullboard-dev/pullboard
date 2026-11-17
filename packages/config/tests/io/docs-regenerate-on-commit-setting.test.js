/** docs.regenerateOnCommit is a machine setting, off by default, described, and on only for an exact true [C7,#9664]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { docsRegenerateOnCommit } from '../../index.js';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-docs-regenerate-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.io-docs-regenerate-on-commit-setting.clause-1-docs-regenerateoncommit-is-a: clause 1: docs.regenerateOnCommit is a described setting, off by default, on only for an exact true [C7,#9664]', () => {
  const row = withSettings({}, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'docs.regenerateOnCommit'));
  assert.equal(row.default, false);
  assert.equal(row.value, false);
  assert.ok(row.label, 'the row carries a plain label');
  assert.equal(withSettings({}, docsRegenerateOnCommit), false);
  assert.equal(withSettings({ docs: { regenerateOnCommit: true } }, docsRegenerateOnCommit), true);
  assert.throws(() => withSettings({ docs: { regenerateOnCommit: 'yes' } }, docsRegenerateOnCommit), /docs\.regenerateOnCommit/u);
});
