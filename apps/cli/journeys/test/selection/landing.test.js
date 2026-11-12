/** Hidden failures, tier manifests, batch bisection and landing contracts stay visible to selection [C7,CS4,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  runFixtureChild,
} from '../../../tests/fixtures/child.js';
import { writeTestTiers } from '../../../../../packages/gate/index.js';
import { runSubmitGate } from '../../../../../packages/gate/index.js';
import { loadConfig } from '../../../../../packages/config/index.js';
import { executionServices } from '../../../tests/fixtures/gate/execution.js';
import {
  json,
  commit,
  calls,
  fixture,
  build,
  accept,
} from '../../../tests/fixtures/test/selection.js';

test('hiding a real broken package from the supplied selection fails the run [C7,CS4,V4]', async t => {
  const box = fixture(t), entry = build(box, 'beta', 'broken');
  const actual = runFixtureChild(process.execPath, ['--test', '--test-reporter=tap', 'test/beta.test.js'], { cwd: entry.root, env: box.env, encoding: 'utf8' });
  assert.equal(actual.status, 1, 'the hidden change really breaks its unit contract: ' + actual.stdout + actual.stderr);
  await assert.rejects(runSubmitGate(entry.root, loadConfig(entry.root), { executionServices, base: box.base, trunk: box.base,
    changed: [], check: 'node check.cjs beta', agent: 'web-1', item: String(entry.id) }),
  error => error.code === 'TEST_SELECTION_INCOMPLETE' && error.message.includes('packages/beta/index.js'));
});

test('an edited tier manifest cannot hide a real failing unit [C7,CS4,V4]', async t => {
  const box = fixture(t), entry = build(box, 'beta', 'broken');
  const path = join(entry.root, 'packages/gate/data/tests/tiers.json');
  const hidden = JSON.parse(readFileSync(path, 'utf8'));
  hidden.files = hidden.files.filter(row => row.file !== 'test/beta.test.js');
  writeFileSync(path, JSON.stringify(hidden));
  commit(box, entry.root, 'test: hide the broken unit from declared tiers [G1]');
  const result = await box.runLocal(entry.root, 'submit', String(entry.id), '--no-next', '--json');
  assert.equal(result.code, 1, result.out + result.err);
  assert.equal(JSON.parse(result.out).error.code, 'GATE_RED');
  assert.deepEqual(calls(box, 'beta'), ['beta:"broken"', 'beta:1'], 'the omitted candidate unit fails and its exact main comparison passes');
  assert.equal(json(box, box.repo, 'show', String(entry.id)).item_status, 'claimed');
});

test('clause 1: a real T3 batch failure bisects to its item while package units stay out of batch gates [C7,CS4,V4]', async t => {
  const box = fixture(t), good = build(box, 'alpha', 2);
  json(box, good.root, 'submit', String(good.id), '--no-next');
  accept(box, good);
  const bad = build(box, 'beta', 0, { second: true });
  json(box, bad.root, 'submit', String(bad.id), '--no-next');
  accept(box, bad);
  assert.deepEqual(calls(box, 'journey'), [], 'no journey ran during either submit or review');
  box.env.NODE_TEST_CONTEXT = 'child-v8'; // The batch must execute its independent journey runner too.
  const landing = await box.runLocal(box.repo, 'land', '--max', '2', '--json');
  assert.equal(landing.code, 0, landing.out + landing.err);
  const landed = JSON.parse(landing.out);
  const gateLogs = (landed.batch?.gateResults ?? []).map(row => existsSync(row.logPath) ? readFileSync(row.logPath, 'utf8') : 'no log').join('\n---\n');
  assert.deepEqual(landed.landed, [good.id], `${landing.err}\n${gateLogs}\n${JSON.stringify(landed)}`);
  assert.deepEqual(landed.culprits.map(row => row.id), [bad.id]);
  assert.equal(landed.culprits[0].tests[0].file, 'test/journey.test.js');
  const logs = landed.batch.gateResults.map(row => readFileSync(row.logPath, 'utf8'));
  assert.ok(logs.length > 1, 'the original batch and split trees have actual gate results');
  assert.ok(logs.every(log => log.includes('T3_JOURNEY') && !log.includes('T1_alpha') && !log.includes('T1_beta')), logs.join('\n--- next gate log ---\n'));
  assert.ok(json(box, box.repo, 'show', String(good.id)).item_merged_commit);
  assert.equal(json(box, box.repo, 'show', String(bad.id)).item_status, 'open');
});


test('clause 1 control: a contract that reaches main after submit still runs at landing and blocks a change that breaks it [C7,CS4,V4]', async t => {
  const box = fixture(t), entry = build(box, 'alpha', 2);
  const submitted = json(box, entry.root, 'submit', String(entry.id), '--no-next');
  assert.deepEqual(submitted.gate.files, ['test/alpha.test.js'], 'the submit proof predates the contract');
  accept(box, entry);
  mkdirSync(join(box.repo, 'packages/alpha/contract'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/alpha/contract/door.test.js'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { n } from '../index.js';
test('alpha keeps its front door value [G1]', () => { appendFileSync(${JSON.stringify(join(box.dir, 'contract.log'))}, 'contract:' + JSON.stringify(n) + '\\n'); assert.equal(n, 1); });
`);
  writeTestTiers(box.repo);
  commit(box, box.repo, 'test: alpha front door keeps its value [G1]');
  const blocked = await box.runLocal(box.repo, 'land', '--max', '1', '--json');
  assert.equal(blocked.code, 1, 'a batch that a culprit blocks exits non-zero: ' + blocked.out + blocked.err);
  const landed = JSON.parse(blocked.out);
  assert.deepEqual(landed.landed, [], JSON.stringify(landed));
  assert.ok(calls(box, 'contract').includes('contract:2'), 'landing ran the new contract on the merged tree');
  assert.ok(!json(box, box.repo, 'show', String(entry.id)).item_merged_commit, 'the change that breaks the contract never lands');
});

test('a runner that ignores selected units cannot report a false green [C7,V4]', async t => {
  const box = fixture(t);
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.affectedTests = 'true';
  writeFileSync(path, JSON.stringify(config));
  commit(box, box.repo, 'test: configure a no-op focused runner [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const entry = build(box, 'beta', 'broken');
  const result = await box.runLocal(entry.root, 'submit', String(entry.id), '--no-next', '--json');
  assert.equal(result.code, 1, result.out + result.err);
  assert.equal(JSON.parse(result.out).error.code, 'TEST_SELECTION_UNVERIFIED');
  assert.deepEqual(calls(box, 'beta'), []);
  assert.equal(json(box, box.repo, 'show', String(entry.id)).item_status, 'claimed');
});
