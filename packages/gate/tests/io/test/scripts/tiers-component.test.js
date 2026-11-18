/** @pullboard-test-input source-cell gate */
/** Component tier: a test reaching other packages only through their front doors is T2, behind its own option [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { generateTestTiers } from '../../../../index.js';
import { fixtureCommittedGraph } from '../../../fixtures/testkit.js';

/** Write only synthetic sources in a private Git repository, never running those candidate modules. */
function fixture(t, sources) {
  const graph = fixtureCommittedGraph('pullboard-tier-component-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries({ 'package.json': '{"type":"module"}', ...sources })) graph.put(file, source);
  graph.commit();
  return graph.root;
}

const sources = {
  'packages/math/index.js': 'export { add } from "./src/add.js";',
  'packages/math/src/add.js': 'export const add = (a, b) => a + b;',
  'packages/text/index.js': 'export const title = "text";',
  'test/doors.test.js': 'import "../packages/text/index.js"; import "../packages/math/index.js";',
  'test/deep.test.js': 'import "../packages/text/index.js"; import "../packages/math/src/add.js";',
  'test/cli.test.js': 'import "../packages/text/index.js"; import "../packages/math/index.js"; import { spawnSync } from "node:child_process"; spawnSync("git");',
  'test/single.test.js': 'import "../packages/math/index.js";',
};

/** Read one generated row by its stable repository-relative identity. */
function row(manifest, file) { return manifest.files.find(row => row.file === file); }

test('gate.io-test-scripts-tiers-component.a-test-importing-two-cells-only: clause 1: a test importing two cells only through their index.js is T2 with its doors listed [C7]', t => {
  const report = generateTestTiers(fixture(t, sources), { componentTier: true });
  assert.equal(row(report, 'test/doors.test.js').tier, 'T2');
  assert.deepEqual(row(report, 'test/doors.test.js').doors, ['packages/math/index.js', 'packages/text/index.js']);
  assert.equal(row(report, 'test/deep.test.js').tier, 'T3', 'a deep import is not a front door');
  assert.equal(row(report, 'test/single.test.js').tier, 'T1');
});

test('gate.io-test-scripts-tiers-component.a-test-with-a-cli-witness: clause 2: a test with a CLI witness stays T3 [C7]', t => {
  const report = generateTestTiers(fixture(t, sources), { componentTier: true });
  assert.equal(row(report, 'test/cli.test.js').tier, 'T3');
  assert.equal(row(report, 'test/cli.test.js').doors, undefined);
});

test('gate.io-test-scripts-tiers-component.with-componenttier-off-the-tiers-output: clause 3: with componentTier off the tiers output equals today\'s [C7]', t => {
  const root = fixture(t, sources);
  const off = generateTestTiers(root);
  assert.deepEqual(generateTestTiers(root, { componentTier: false }), off);
  assert.equal(row(off, 'test/doors.test.js').tier, 'T3');
  assert.ok(off.files.every(file => !('doors' in file)));
});
