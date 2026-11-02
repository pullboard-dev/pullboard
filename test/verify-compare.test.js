/** Real persisted items compare actual Node tests at immutable Git sources [V4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChildAsync } from './fixture-child.js';

const CASES = `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {value} from './value.js';
test('new red case [V4,C7]',()=>assert.equal(value.newRed,true));
test('fixed case [V4,C7]',()=>assert.equal(value.fixed,true));
test('known red case [V4,C7]',()=>assert.equal(value.known,true));
test('skip is no fix [V4,C7]',{skip:value.skip},()=>assert.ok(false));
`;
const RUNNER = `import {spawnSync} from 'node:child_process';
const env={...process.env};delete env.NODE_TEST_CONTEXT;
const ran=spawnSync(process.execPath,['--test','--test-reporter=tap',...process.argv.slice(2)],{encoding:'utf8',env});
process.stdout.write(ran.stdout??'');process.stderr.write(ran.stderr??'');process.exitCode=ran.status??1;
`;

/** Build real Git histories and declare synthetic board lifecycle data without claiming a gate ran. */
function fixture(t, { missingRunner = false } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox());
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...helpers.CONFIG,
    gate: 'true', affectedTests: 'node web/runner.js' }));
  if (!missingRunner) writeFileSync(join(box.repo, 'web/runner.js'), RUNNER);
  writeFileSync(join(box.repo, 'web/value.js'), 'export const value={newRed:true,fixed:false,known:false,skip:false};\n');
  writeFileSync(join(box.repo, 'web/a space.test.js'), CASES);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'chore: comparison base [G1]');
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = box.run(box.repo, 'add', 'web', 'Comparison fixture', '--specs', 'G1', '--check', 'true', '--json');
  assert.equal(added.code, 0, added.out + added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(id, 1);
  assert.equal(box.run(box.web, 'claim', String(id)).code, 0);
  return { ...box, helpers, id, base };
}

/** Record the exact submitted source through the existing explicitly synthetic lifecycle helper. */
function submit(box) {
  const commit = box.helpers.attackCommit(box, box.web);
  box.helpers.historicalCheckSubmission(box, commit);
  return commit;
}

/** Execute the public diagnostic and check its durable execution identities and unchanged item state. */
async function compare(box) {
  const result = await runFixtureChildAsync(process.execPath,
    [box.helpers.BIN, 'verify', String(box.id), '--compare', '--json'], { cwd: box.web, env: box.env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const compared = JSON.parse(result.stdout);
  for (const side of ['head', 'base']) {
    assert.match(compared[side].id, /^[a-f0-9-]{36}$/u);
    const recorded = JSON.parse(readFileSync(join(box.repo, '.git/pullboard/check-output', `compare-${compared[side].id}.json`), 'utf8'));
    assert.equal(recorded.commit, compared[side + 'Commit']);
    assert.ok(readFileSync(recorded.profileFile, 'utf8').length > 0);
  }
  const shown = box.run(box.repo, 'show', String(box.id), '--json');
  assert.equal(JSON.parse(shown.out).item_status, 'submitted', 'comparison never gives a verdict');
  return compared;
}

test('verify --compare selects importing tests and reports only new reds and actual fixes [V4,C7]', async t => {
  const box = fixture(t);
  writeFileSync(join(box.web, 'web/value.js'), 'export const value={newRed:false,fixed:true,known:false,skip:true};\n');
  const head = submit(box);
  const result = await compare(box);
  assert.equal(result.headCommit, head);
  assert.equal(result.baseCommit, box.base);
  assert.deepEqual(result.files, ['web/a space.test.js']);
  assert.deepEqual(result.newRed.map(row => row.name), ['new red case [V4,C7]']);
  assert.deepEqual(result.fixed.map(row => row.name), ['fixed case [V4,C7]']);
  assert.equal(result.fallback, null);
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), head);
});

test('verify --compare treats an added test file as new and does not execute its missing base path [V4,C7]', async t => {
  const box = fixture(t);
  writeFileSync(join(box.web, 'web/added.test.js'), "import {test} from 'node:test';import assert from 'node:assert/strict';test('added red [V4,C7]',()=>assert.ok(false));\n");
  submit(box);
  const result = await compare(box);
  assert.deepEqual(result.newFiles, ['web/added.test.js']);
  assert.deepEqual(result.base.files, []);
  assert.deepEqual(result.newRed.map(row => row.name), ['added red [V4,C7]']);
  assert.equal(result.fallback, null);
});

test('verify --compare falls back from an unrunnable base to composed head versus main [V4,C7]', async t => {
  const box = fixture(t, { missingRunner: true });
  writeFileSync(join(box.repo, 'web/runner.js'), RUNNER);
  box.git(box.repo, 'add', 'web/runner.js');
  box.git(box.repo, 'commit', '-qm', 'fix: provide current runner [G1]');
  const main = box.git(box.repo, 'rev-parse', 'HEAD');
  writeFileSync(join(box.web, 'web/runner.js'), RUNNER);
  writeFileSync(join(box.web, 'web/value.js'), 'export const value={newRed:false,fixed:true,known:false,skip:false};\n');
  const head = submit(box);
  const result = await compare(box);
  assert.equal(result.fallback.base, box.base);
  assert.equal(result.baseCommit, main);
  assert.notEqual(result.headCommit, head);
  assert.deepEqual(result.newRed.map(row => row.name), ['new red case [V4,C7]']);
  assert.deepEqual(result.fixed.map(row => row.name), ['fixed case [V4,C7]']);
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), head);
});
