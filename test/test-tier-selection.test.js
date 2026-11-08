/** Real committed selection, private review and batch bisection retain the tier contract [C7,CS4,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';
import { writeTestTiers } from '../packages/gate/index.js';
import { runSubmitGate } from '../packages/gate/index.js';
import { loadConfig } from '../packages/config/index.js';
import { executionServices } from './gate-execution-fixture.js';
import { joinFixtureSeat } from './testkit-fixture.js';

/** Demand a real successful private CLI document. */
function json(box, root, ...args) {
  const result = box.run(root, ...args, '--json');
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

/** Commit fixture source through ordinary installed hooks. */
function commit(box, root, message) {
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', message);
  return box.git(root, 'rev-parse', 'HEAD');
}

/** Read actual executed fixture markers; missing logs mean nothing ran. */
function calls(box, name) {
  const file = join(box.dir, `${name}.log`);
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
}

/** Prepare two unit packages, one unitless package and one cross-package journey. */
function fixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('node --test --test-reporter=tap');
  delete box.env.NODE_TEST_CONTEXT; // Each private Node test runner is independent of this parent test.
  const config = { ...helpers.CONFIG, gate: 'node --test --test-reporter=tap', affectedTests: 'node --test --test-reporter=tap',
    submitGate: 'landing', submitInvariants: [], registryGuards: [], landing: { perItem: false, manualOverride: true, publish: 'separate', parallel: false },
    lanes: { ...helpers.CONFIG.lanes, web: { owns: ['packages/', 'test/'], specs: ['G1'] } } };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  for (const name of ['alpha', 'beta', 'gamma']) {
    mkdirSync(join(box.repo, `packages/${name}`), { recursive: true });
    writeFileSync(join(box.repo, `packages/${name}/index.js`), 'export const n = 1;\n');
  }
  for (const name of ['alpha', 'beta']) writeFileSync(join(box.repo, `test/${name}.test.js`), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { n } from '../packages/${name}/index.js';
test('${name} exposes a number [G1]', () => { appendFileSync(${JSON.stringify(join(box.dir, `${name}.log`))}, '${name}:' + JSON.stringify(n) + '\\n'); console.log('T1_${name}'); assert.equal(typeof n, 'number'); });
`);
  writeFileSync(join(box.repo, 'test/journey.test.js'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { n as alpha } from '../packages/alpha/index.js';
import { n as beta } from '../packages/beta/index.js';
test('both packages preserve the positive journey [G1]', () => { appendFileSync(${JSON.stringify(join(box.dir, 'journey.log'))}, 'journey\\n'); console.log('T3_JOURNEY'); assert.ok(alpha > 0 && beta > 0); });
`);
  writeFileSync(join(box.repo, 'check.cjs'), `const fs = require('node:fs'); const assert = require('node:assert/strict'); assert.ok(fs.existsSync('packages/' + process.argv[2] + '/index.js')); console.log('FROZEN_' + process.argv[2]);\n`);
  const manifest = writeTestTiers(box.repo).manifest;
  assert.deepEqual(manifest.files.map(row => [row.file, row.tier]), [['test/alpha.test.js', 'T1'], ['test/beta.test.js', 'T1'], ['test/journey.test.js', 'T3']]);
  const base = commit(box, box.repo, 'test: configure immutable testing tiers [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return { ...box, base };
}

/** Build exactly one package from main without stacking another item's source. */
function build(box, name, value, { second = false } = {}) {
  let root = box.web;
  if (second) {
    root = join(box.dir, `builder-${name}`);
    box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/${name}`, root, 'main');
    joinFixtureSeat(box, root, 'web', { route: 'strong' });
  }
  const id = json(box, box.repo, 'add', 'web', `Change ${name}`, '--specs', 'G1', '--criterion', `The ${name} package remains present and its unit contract holds.`, '--check', `node check.cjs ${name}`, '--route', 'strong').item.item_id;
  json(box, root, 'claim', String(id));
  writeFileSync(join(root, `packages/${name}/index.js`), `export const n = ${JSON.stringify(value)};\n`);
  const head = commit(box, root, `feat(web): change ${name} [G1]`);
  return { id, root, head };
}

/** Accept only this synthetic private item after the actual frozen check and unit proof. */
function accept(box, entry) {
  const root = join(box.dir, `review-${entry.id}`);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', root, entry.head);
  joinFixtureSeat(box, root, 'api', { route: 'strong' });
  const result = box.run(root, 'verify', String(entry.id), 'accept', '--note', 'The private frozen check and changed package units passed.');
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /T1 unit tests/u);
  assert.match(result.out, /T3 journeys deferred to the landing batch/u);
}

test('submit and review run only the changed package units and frozen check [C7,CS4,V4]', t => {
  const box = fixture(t), entry = build(box, 'alpha', 2);
  box.env.NODE_TEST_CONTEXT = 'child-v8'; // Deliberate inherited context must not skip the selected units.
  const submitted = json(box, entry.root, 'submit', String(entry.id), '--no-next');
  assert.deepEqual(submitted.gate.files, ['test/alpha.test.js']);
  // RFC 0006 A3: the repository root imports alpha's front door, so its hash changes and it runs beside alpha.
  assert.deepEqual(submitted.gate.testTiers.packages, ['.', 'packages/alpha']);
  assert.deepEqual(submitted.gate.testTiers.journeys, ['test/journey.test.js']);
  assert.equal(submitted.gate.check.checked, true);
  assert.deepEqual(submitted.gate.phasePlan.map(phase => phase.role), ['criterion', 'proof']);
  assert.deepEqual(calls(box, 'alpha'), ['alpha:2']);
  assert.deepEqual(calls(box, 'beta'), []);
  assert.deepEqual(calls(box, 'journey'), []);
  accept(box, entry);
  assert.deepEqual(calls(box, 'alpha'), ['alpha:2'], 'review reuses the submit proof of the package unit instead of running it again');
  assert.deepEqual(calls(box, 'beta'), []);
  assert.deepEqual(calls(box, 'journey'), []);
});

test('a journey test the change itself edits runs at submit, not first at landing [C7,CS4,V4]', t => {
  const box = fixture(t), entry = build(box, 'gamma', 2);
  const journey = join(entry.root, 'test/journey.test.js');
  writeFileSync(journey, readFileSync(journey, 'utf8').replace("'journey\\n'", "'journey-edited\\n'"));
  const head = commit(box, entry.root, 'test(web): the journey records its edit [G1]');
  assert.notEqual(head, entry.head);
  const submitted = json(box, entry.root, 'submit', String(entry.id), '--no-next');
  assert.ok(submitted.gate.files.includes('test/journey.test.js'), submitted.gate.files.join(', '));
  assert.deepEqual(submitted.gate.testTiers.journeys, []);
  assert.deepEqual(calls(box, 'journey'), ['journey-edited']);
});

test('a red in a journey test the change edits turns the submit gate red [C7,CS4,V4]', t => {
  const box = fixture(t), entry = build(box, 'gamma', 2);
  const journey = join(entry.root, 'test/journey.test.js');
  writeFileSync(journey, readFileSync(journey, 'utf8').replace('assert.ok(alpha > 0 && beta > 0)', 'assert.ok(alpha < 0, "edited journey is red")'));
  commit(box, entry.root, 'test(web): the journey asserts the wrong sign [G1]');
  const result = box.run(entry.root, 'submit', String(entry.id), '--no-next', '--json');
  assert.notEqual(result.code, 0, 'a red edited journey must not submit green');
  assert.match(result.out + result.err, /journey\.test\.js/u);
  assert.ok(calls(box, 'journey').length >= 1, 'the edited journey ran at submit');
});

test('a package with no units runs only its frozen check [C7,CS4,V4]', t => {
  const box = fixture(t), entry = build(box, 'gamma', 2);
  const submitted = json(box, entry.root, 'submit', String(entry.id), '--no-next');
  assert.deepEqual(submitted.gate.files, []);
  assert.deepEqual(submitted.gate.testTiers.units, []);
  assert.equal(submitted.gate.check.green, true);
  assert.deepEqual(submitted.gate.phasePlan.map(phase => phase.role), ['criterion']);
  assert.equal(submitted.gate.proofReceiptIds.length, 1, 'one real frozen proof and no unit phase');
  assert.deepEqual(calls(box, 'alpha'), []);
  assert.deepEqual(calls(box, 'beta'), []);
  assert.deepEqual(calls(box, 'journey'), []);
});

test('hiding a real broken package from the supplied selection fails the run [C7,CS4,V4]', async t => {
  const box = fixture(t), entry = build(box, 'beta', 'broken');
  const actual = runFixtureChild(process.execPath, ['--test', '--test-reporter=tap', 'test/beta.test.js'], { cwd: entry.root, env: box.env, encoding: 'utf8' });
  assert.equal(actual.status, 1, 'the hidden change really breaks its unit contract: ' + actual.stdout + actual.stderr);
  await assert.rejects(runSubmitGate(entry.root, loadConfig(entry.root), { executionServices, base: box.base, trunk: box.base,
    changed: [], check: 'node check.cjs beta', agent: 'web-1', item: String(entry.id) }),
  error => error.code === 'TEST_SELECTION_INCOMPLETE' && error.message.includes('packages/beta/index.js'));
});

test('an edited tier manifest cannot hide a real failing unit [C7,CS4,V4]', t => {
  const box = fixture(t), entry = build(box, 'beta', 'broken');
  const path = join(entry.root, 'packages/gate/test-tiers.json');
  const hidden = JSON.parse(readFileSync(path, 'utf8'));
  hidden.files = hidden.files.filter(row => row.file !== 'test/beta.test.js');
  writeFileSync(path, JSON.stringify(hidden));
  commit(box, entry.root, 'test: hide the broken unit from declared tiers [G1]');
  const result = box.run(entry.root, 'submit', String(entry.id), '--no-next', '--json');
  assert.equal(result.code, 1, result.out + result.err);
  assert.equal(JSON.parse(result.out).error.code, 'GATE_RED');
  assert.deepEqual(calls(box, 'beta'), ['beta:"broken"', 'beta:1'], 'the omitted candidate unit fails and its exact main comparison passes');
  assert.equal(json(box, box.repo, 'show', String(entry.id)).item_status, 'claimed');
});

test('a real T3 batch failure bisects to its item while package units stay out of batch gates [C7,CS4,V4]', t => {
  const box = fixture(t), good = build(box, 'alpha', 2);
  json(box, good.root, 'submit', String(good.id), '--no-next');
  accept(box, good);
  const bad = build(box, 'beta', 0, { second: true });
  json(box, bad.root, 'submit', String(bad.id), '--no-next');
  accept(box, bad);
  assert.deepEqual(calls(box, 'journey'), [], 'no journey ran during either submit or review');
  box.env.NODE_TEST_CONTEXT = 'child-v8'; // The batch must execute its independent journey runner too.
  const landing = box.run(box.repo, 'land', '--max', '2', '--json');
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


test('control: a contract that reaches main after submit still runs at landing and blocks a change that breaks it [C7,CS4,V4]', t => {
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
  const landed = json(box, box.repo, 'land', '--max', '1');
  assert.deepEqual(landed.landed, [], JSON.stringify(landed));
  assert.ok(calls(box, 'contract').includes('contract:2'), 'landing ran the new contract on the merged tree');
  assert.ok(!json(box, box.repo, 'show', String(entry.id)).item_merged_commit, 'the change that breaks the contract never lands');
});

test('a runner that ignores selected units cannot report a false green [C7,V4]', t => {
  const box = fixture(t);
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.affectedTests = 'true';
  writeFileSync(path, JSON.stringify(config));
  commit(box, box.repo, 'test: configure a no-op focused runner [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const entry = build(box, 'beta', 'broken');
  const result = box.run(entry.root, 'submit', String(entry.id), '--no-next', '--json');
  assert.equal(result.code, 1, result.out + result.err);
  assert.equal(JSON.parse(result.out).error.code, 'TEST_SELECTION_UNVERIFIED');
  assert.deepEqual(calls(box, 'beta'), []);
  assert.equal(json(box, box.repo, 'show', String(entry.id)).item_status, 'claimed');
});
