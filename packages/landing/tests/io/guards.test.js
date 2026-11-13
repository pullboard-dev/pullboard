/** Generated affected phases retain real shell boundaries without guessing opaque commands [C7,V4]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { accountedFailures } from '../../index.js';
import { land } from '../../index.js';
import { landingWaivers } from '../../index.js';
import { requireLandingModuleResolution } from '../../index.js';
import { requireLandingSecretFree } from '../../index.js';
import { scanLanding } from '../../src/io/scan.js';
import { landingPorts } from '../../../../apps/cli/tests/fixtures/landing/ports.js';
import { runShell } from '../../../gate/index.js';
import { runFixtureGit } from '../../../../apps/cli/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';

/** Build two genuine shell children with distinct TAP accounts and observable working directories. */
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-affected-stages-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q'], { cwd: root });
  assert.equal(existsSync(join(root, '.git')), true);
  mkdirSync(join(root, 'work'));
  for (const [name, red] of [['floor', false], ['affected', true]]) {
    const output = `TAP version 13\n${red ? 'not ok' : 'ok'} 1 - ${name}\n`
      + (red ? '  ---\n  location: test/red.test.js:1:1\n  ...\n' : '')
      + `1..1\n# tests 1\n# pass ${red ? 0 : 1}\n# fail ${red ? 1 : 0}\n`;
    writeFileSync(join(root, `${name}.cjs`), `require('node:fs').writeFileSync(${JSON.stringify(join(root, `${name}.cwd`))}, process.cwd());\n`
      + `process.stdout.write(${JSON.stringify(output)});\nprocess.exitCode = ${red ? 1 : 0};\n`);
  }
  return root;
}

/** Match the exact composition emitted by landing, using the actual declared Node runtime. */
function composed(root, original) {
  return runShell(root, `(\n${original}\n) && '${process.execPath}' affected.cjs`, { stages: true, pipefail: true });
}

test('compound shell conditionals keep their actual branches and exit status without guessed accounting [C7,V4,B3]', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'armed'), 'yes');
  const command = "printf initial > before.txt && if test -f armed; then printf branch >> branch.txt; fi && if test -f absent; then exit 9; fi";
  const plain = runShell(root, command);
  const observed = runShell(root, command, { stages: true });
  assert.equal(plain.isGreen, true);
  assert.equal(observed.isGreen, true, observed.output);
  assert.equal(readFileSync(join(root, 'before.txt'), 'utf8'), 'initial');
  assert.equal(readFileSync(join(root, 'branch.txt'), 'utf8'), 'branchbranch', 'each actual invocation executes its branch exactly once');
  assert.equal(observed.stages, null, 'an opaque compound never receives a guessed stage account');
  const red = runShell(root, 'if test -f armed; then false; else true; fi', { stages: true });
  assert.equal(red.isGreen, false);
  assert.equal(red.exitCode, 1);
  assert.equal(red.stages, null);
  assert.equal(accountedFailures(red, root), null, 'an opaque red command cannot borrow a waiver account');
});

test('quoted shell keywords remain ordinary arguments in actual staged execution [C7,V4]', t => {
  const root = fixture(t);
  const run = runShell(root, "printf '%s\\n' 'if then fi' && false", { stages: true });
  assert.equal(run.isGreen, false);
  assert.deepEqual(run.stages.map(stage => stage.status), [0, 1]);
  assert.match(run.output, /if then fi/u);
});

test('generated phases retain original directory changes and separate affected failures [C7,V4]', t => {
  const root = fixture(t);
  const run = composed(root, `cd work && '${process.execPath}' ../floor.cjs`);
  assert.equal(run.isGreen, false);
  assert.equal(readFileSync(join(root, 'floor.cwd'), 'utf8'), join(root, 'work'));
  assert.equal(readFileSync(join(root, 'affected.cwd'), 'utf8'), root);
  assert.deepEqual(run.stages.map(stage => stage.status), [0, 0, 1]);
  assert.deepEqual(accountedFailures(run, root), [{ file: 'test/red.test.js', name: 'affected' }]);
});

test('generated phases retain independent pipeline failures rather than borrowing TAP [C7,V4]', async t => {
  const root = fixture(t);
  const probe = spawnSync('set -o pipefail', { cwd: root, shell: true, encoding: 'utf8' });
  if (probe.status !== 0) {
    assert.throws(() => composed(root, `false | '${process.execPath}' affected.cjs`),
      { code: 'PIPEFAIL_UNAVAILABLE' }, 'the actual native shell must refuse an unprotected pipeline');
    assert.equal(existsSync(join(root, 'affected.cwd')), false, 'the refused pipeline never executes');
  }
  await t.test('native shell records every pipeline component', {
    skip: probe.status === 0 ? false : 'native /bin/sh cannot enable pipefail; its PIPEFAIL_UNAVAILABLE refusal is asserted above',
  }, () => {
    const bad = composed(root, `false | '${process.execPath}' affected.cjs`);
    assert.equal(bad.isGreen, false);
    assert.equal(bad.stages[0].pipeline[0].status, 1);
    assert.equal(accountedFailures(bad, root), null);
    const good = composed(root, `'${process.execPath}' floor.cjs | cat`);
    assert.deepEqual(good.stages[0].pipeline.map(component => component.status), [0, 0]);
    assert.deepEqual(accountedFailures(good, root), [{ file: 'test/red.test.js', name: 'affected' }]);
  });
});

test('an exit in the configured phase cannot skip the affected phase or earn a waiver [C7,V4]', t => {
  const root = fixture(t);
  const run = composed(root, `'${process.execPath}' floor.cjs; exit 0`);
  assert.equal(run.isGreen, false);
  assert.equal(existsSync(join(root, 'affected.cwd')), true, 'the affected child actually executes');
  assert.equal(run.stages[1].status, null, 'the interrupted original stage never gains an exit receipt');
  assert.equal(accountedFailures(run, root), null);
});

/** Required provider checks precede real Git, lease, process and board work in each public component entry. */
test('missing landing providers refuse before admission or work can begin [B3,R3,Q1,Q3,C7]', async () => {
  let called = false;
  const untouched = new Proxy({}, { get() { called = true; throw new Error('provider refusal read the board'); } });
  for (const ports of [undefined, ...['flakeLedger', 'quarantineWaivers', 'observeNativeFailure', 'quarantineVerdictSnapshot',
    'validateQuarantineGate', 'validateQuarantineLandingProof', 'gateRuns'].map(name => ({ ...landingPorts, [name]: undefined }))]) {
    await assert.rejects(land({ root: '/missing-landing-provider', board: untouched, landingPorts: ports }), /explicit canonical operation ports/u);
  }
  assert.throws(() => landingWaivers(untouched), /explicit quarantine reader/u);
  assert.equal(called, false, 'missing providers never read the board or enter the lease callback');
});

/** A fake AWS key built at run time, so this file's own source never matches the pre-commit scanner. */
const FAKE_KEY = ['AK', 'IA'].join('') + 'Q7'.repeat(8);

/** A real repo on main whose base holds `baseFiles`; `candidate` commits files on top and leaves that tip checked out. */
function secretRepo(t, baseFiles = { 'a.js': 'export const a = 1;\n' }) {
  const { root } = privateFixtureFiles('landing-secret-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sh = (...args) => runFixtureGit(args, { cwd: root });
  const commit = files => {
    for (const [file, source] of Object.entries(files)) writeFileSync(join(root, file), source);
    sh('add', '-A');
    sh('commit', '-q', '--no-verify', '-m', 'commit');
    return sh('rev-parse', 'HEAD');
  };
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@example.com');
  sh('config', 'user.name', 't');
  return { root, sh, base: commit(baseFiles), candidate: commit };
}

test('every landing guard refuses a candidate that adds a secret over main, naming file:line and never the value [C7,#5968]', async t => {
  const { root, base, candidate } = secretRepo(t);
  const tip = candidate({ 'config.js': `export const region = 'us-east-1';\nexport const key = '${FAKE_KEY}';\n` });
  const refused = error => {
    assert.equal(error.code, 'LANDING_SECRET');
    assert.match(error.message, /AWS access key at config\.js:2/u);
    assert.equal(JSON.stringify({ message: error.message, stack: error.stack, found: error.found, next: error.next }).includes(FAKE_KEY), false, 'the value is never printed');
    return true;
  };
  // Merge's runner branch calls the scan alone; merge, publish, trunk, followup and `merged` reach it through module resolution.
  assert.throws(() => requireLandingSecretFree(root, base, tip), refused);
  await assert.rejects(requireLandingModuleResolution(root, base, tip), refused);
  // A named batch's runner-side scan reports it as a static row the coordinator attributes to the item.
  const rows = await scanLanding(root, base, tip);
  assert.deepEqual(rows, ['config.js:2: LANDING_SECRET AWS access key']);
  assert.equal(rows.join('\n').includes(FAKE_KEY), false);
});

test('a clean candidate passes every landing guard unchanged, even over a main that already held a secret [C7,#5968]', async t => {
  const { root, sh, base, candidate } = secretRepo(t, { 'a.js': 'export const a = 1;\n', 'old.js': `export const key = '${FAKE_KEY}';\n` });
  const tip = candidate({ 'b.js': "import { a } from './a.js';\nexport const b = a;\n" });
  const tree = sh('rev-parse', 'HEAD^{tree}');
  assert.doesNotThrow(() => requireLandingSecretFree(root, base, tip));
  await requireLandingModuleResolution(root, base, tip);
  assert.deepEqual(await scanLanding(root, base, tip), []);
  assert.equal(sh('rev-parse', 'HEAD'), tip, 'the guards add no commit');
  assert.equal(sh('rev-parse', 'HEAD^{tree}'), tree, 'the candidate tree is unchanged');
  assert.equal(sh('status', '--porcelain'), '', 'the guards write nothing');
});
