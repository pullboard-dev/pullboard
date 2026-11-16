/** A copied template root gets its Claude settings file rewritten to the new root [C7,#8997]. */
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../child.js';
import { relocateClaudeSettings } from './release.js';
import { releaseFixture } from './release.js';

test('clause 1: a copied template root has a Claude settings file naming only the new root path [C7,#8997]', t => {
  const template = releaseFixture(t);
  const copy = privateFixtureFiles('pullboard-resume-copy-').root;
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(template.root, copy, { recursive: true, verbatimSymlinks: true });
  const file = join(copy, 'repo', '.claude', 'settings.json');
  const before = readFileSync(file, 'utf8');
  assert.ok(before.includes(template.root) || before.includes(realpathSync(template.root)), 'the copy starts out naming the template root');
  relocateClaudeSettings(template.root, copy);
  const after = readFileSync(file, 'utf8');
  assert.ok(after.includes(copy), 'the settings name the new root');
  for (const spelling of new Set([template.root, realpathSync(template.root)])) assert.ok(!after.includes(spelling), `the settings no longer name ${spelling}`);
});
