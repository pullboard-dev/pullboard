/** Submit lists the import edges a diff adds when submit.edgeFollowUps is on, and the setting is off by default [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { configFromSource } from '../../../../config/index.js';
import { submitImportEdges } from '../../../src/io/submit-edges.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureSetupGit } from '../../fixtures/child.js';
import { fixtureCommitAll } from '../../fixtures/testkit.js';

test('clause 1: submit.edgeFollowUps exists and defaults to off [C7]', () => {
  assert.equal(configFromSource('{}').submit.edgeFollowUps, false);
  assert.equal(configFromSource(JSON.stringify({ submit: { requireInfraNote: false, autoFileMainReds: false, edgeFollowUps: true } })).submit.edgeFollowUps, true);
});

test('clause 2: with the setting on, the submit stage returns the import edges the diff adds, and nothing with it off [C7]', t => {
  const root = privateFixtureFiles('pullboard-edge-follow-ups-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => runFixtureSetupGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: root });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.js'), "import './b.js';\n");
  writeFileSync(join(root, 'src/b.js'), 'export const b = 1;\n');
  writeFileSync(join(root, 'src/c.js'), 'export const c = 1;\n');
  fixtureCommitAll(root);
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'src/a.js'), "import './b.js';\nimport './c.js';\n");
  writeFileSync(join(root, 'src/b.js'), "import './c.js';\nexport const b = 1;\n");
  git('add', '-A'); git('commit', '-q', '-m', 'edit');
  const on = { submit: { edgeFollowUps: true } };
  assert.deepEqual(submitImportEdges(root, on, { base }), [{ from: 'src/a.js', to: 'src/c.js' }, { from: 'src/b.js', to: 'src/c.js' }]);
  assert.deepEqual(submitImportEdges(root, { submit: { edgeFollowUps: false } }, { base }), []);
});
