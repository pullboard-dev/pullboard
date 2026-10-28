/** Generated affected phases retain real shell boundaries without guessing opaque commands [C7,V4]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { accountedFailures } from '../src/land.js';
import { land } from '../src/land.js';
import { runLandingBatch } from '../src/land.js';
import { runLandingCandidate } from '../src/land.js';
import { runLandingShards } from '../src/landing-shards.js';
import { runLandingWorker } from '../src/landing-worker.js';
import { landingWaivers } from '../src/landing-waivers.js';
import { landingPorts } from './landing-ports-fixture.js';
import { runShell } from '../src/shell-run.js';
import { runFixtureGit } from './fixture-child.js';

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
  for (const ports of [undefined, { ...landingPorts, quarantineWaivers: undefined }, { ...landingPorts, observeNativeFailure: undefined }]) {
    await assert.rejects(land({ root: '/missing-landing-provider', board: untouched, landingPorts: ports }), /explicit canonical operation ports/u);
    await assert.rejects(runLandingBatch({ root: '/missing-landing-provider', board: untouched, landingPorts: ports }), /explicit canonical operation ports/u);
    await assert.rejects(runLandingCandidate({ root: '/missing-landing-provider', board: untouched, landingPorts: ports,
      checkLease() { called = true; } }), /explicit canonical operation ports/u);
  }
  await assert.rejects(runLandingShards({ root: '/missing-landing-parser' }), /explicit process census parser/u);
  await assert.rejects(runLandingWorker({ root: '/missing-landing-parser' }, {}), /explicit process census parser/u);
  assert.throws(() => landingWaivers(untouched), /explicit quarantine reader/u);
  assert.equal(called, false, 'missing providers never read the board or enter the lease callback');
});
