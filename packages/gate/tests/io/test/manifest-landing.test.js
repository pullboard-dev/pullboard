/** The test manifest follows each landing's added and deleted test files and records measured file times without churn [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { deriveTestRegistries } from '../../../index.js';
import { retainTestValueTimings } from '../../../index.js';

const MANIFEST = 'packages/gate/data/tests/test-manifest.json';
const A = 'packages/cell/tests/alpha.test.js';
const B = 'packages/cell/tests/beta.test.js';
const body = id => `import { test } from 'node:test';\n\ntest('${id}: [C7] holds', () => {});\n`;

/** A real repo with one manifest-listed test file and no recorded time. */
function repo(t) {
  const { root } = privateFixtureFiles('gate-manifest-landing-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sh = (...args) => runFixtureGit(args, { cwd: root });
  const put = (file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@example.com');
  sh('config', 'user.name', 't');
  put('package.json', '{"type":"module"}\n');
  put(A, body('cell.alpha.one'));
  put(MANIFEST, '{\n  "version": 1,\n  "files": [\n  ]\n}\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'base');
  return { root, put, sh, rows: () => JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')).files };
}

/** Record one gate run's measured file times the way the gate retains them. */
function gateRun(root, id, files) {
  const store = join(root, '.git', 'pullboard', 'gate-receipts');
  assert.ok(retainTestValueTimings(store, id, { files: files.map(([path, durationMs]) => ({ path, durationMs })) }));
}

test('clause 1: [C7] a landing that adds or deletes a test file updates its manifest row in the same landing', t => {
  const box = repo(t);
  deriveTestRegistries(box.root, { touched: [A] });
  assert.deepEqual(box.rows().map(row => row.file), [A]);
  box.put(B, body('cell.beta.one'));
  box.sh('rm', '-q', A);
  box.sh('add', '-A');
  const changed = deriveTestRegistries(box.root, { touched: [B] });
  assert.ok(changed.includes(MANIFEST));
  assert.deepEqual(box.rows().map(row => row.file), [B], 'the added file has a row and the deleted file has none');
});

test('clause 2: [C7] a gate run records each test file measured time into its manifest row, and jitter rewrites nothing', t => {
  const box = repo(t);
  assert.equal(deriveTestRegistries(box.root, { touched: [A] }).includes(MANIFEST), true);
  assert.equal(box.rows()[0].cost.ms, null);
  gateRun(box.root, '11111111-1111-4111-8111-111111111111', [[A, 1000]]);
  deriveTestRegistries(box.root, { touched: [] });
  assert.equal(box.rows()[0].cost.ms, 1000);
  const text = readFileSync(join(box.root, MANIFEST), 'utf8');
  gateRun(box.root, '22222222-2222-4222-8222-222222222222', [[A, 1100]]);
  assert.equal(deriveTestRegistries(box.root, { touched: [] }).includes(MANIFEST), false, 'a 10% jitter leaves the file alone');
  assert.equal(readFileSync(join(box.root, MANIFEST), 'utf8'), text);
  gateRun(box.root, '33333333-3333-4333-8333-333333333333', [[A, 2000]]);
  deriveTestRegistries(box.root, { touched: [] });
  assert.equal(box.rows()[0].cost.ms, 2000, 'a real change is recorded');
});
