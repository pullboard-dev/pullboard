/** @pullboard-test-loads packages/gate/src/io/browser/admission.js */
/** Real gates and item checks share the machine queue; landing priority and lease behavior stay intact [Q1,Q2,Q4,O5,O6,V18]. */
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../fixtures/child.js';
import { runFixtureChild } from '../../fixtures/child.js';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { quote } from '../../fixtures/resource.js';
import { fixture } from '../../fixtures/resource.js';
import { probeSuite } from '../../fixtures/resource.js';
import { withNestedGroup } from '../../../index.js';
import { launchTestRunner } from '../../fixtures/resource.js';
import { gateRepo } from '../../fixtures/resource.js';
import { waitFor } from '../../fixtures/resource.js';
import { events } from '../../fixtures/resource.js';
import { RUNNER } from '../../fixtures/resource.js';
import { PROBE_PATTERN } from '../../fixtures/resource.js';
import { PROBE_PATH_ENV } from '../../fixtures/resource.js';
import { reapFixtures } from '../../fixtures/resource.js';
import { launch } from '../../fixtures/resource.js';
import { setOneGateSlot } from '../../fixtures/resource.js';

const BROWSER_ADMISSION_MODULE = pathToFileURL(resolve(import.meta.dirname, '../../../index.js')).href;

after(reapFixtures);

test('gate.io-main-resource.a-short-slot-is-offered-only: a short slot is offered only to a literal runner call over regular test files [C7]', async () => {
  const { explicitCheckFiles } = await import(BROWSER_ADMISSION_MODULE);
  const root = process.cwd();
  const named = `${quote(process.execPath)} apps/cli/src/io/run/tests.js packages/gate/tests/io/main/resource.test.js`;
  assert.deepEqual(await explicitCheckFiles(root, named), ['packages/gate/tests/io/main/resource.test.js']);
  assert.deepEqual(await explicitCheckFiles(root, `out=$(${named} 2>&1); printf '%s\\n' "$out"; printf '%s\\n' "$out" | grep -Eq '^[[:space:]]*ok [0-9]+ - .*probe' && printf '%s\\n' "$out" | grep -Eq '^# fail 0$'`), ['packages/gate/tests/io/main/resource.test.js'], 'the frozen-check capture form names its files');
  assert.equal(await explicitCheckFiles(root, `${quote(process.execPath)} apps/cli/src/io/run/tests.js`), null, 'a whole suite is not short');
  assert.equal(await explicitCheckFiles(root, `${quote(process.execPath)} apps/cli/src/io/run/tests.js test/`), null, 'a directory is not short');
  assert.equal(await explicitCheckFiles(root, 'npm test packages/gate/tests/io/main/resource.test.js'), null, 'an opaque runner is not short');
  assert.equal(await explicitCheckFiles(root, 'node apps/cli/src/io/run/tests.js packages/gate/tests/../../../test/cells.test.js'), null, 'path traversal is not a package test');
  assert.equal(await explicitCheckFiles(root, 'node apps/cli/src/io/run/tests.js $(printf packages/gate/tests/io/main/resource.test.js)'), null, 'shell expansion is not short');
  assert.equal(await explicitCheckFiles(root, 'node apps/cli/src/io/run/tests.js --unknown packages/gate/tests/io/main/resource.test.js'), null, 'an unknown option is not short');
  assert.equal(await explicitCheckFiles(root, 'node apps/cli/src/io/run/tests.js test/short-missing.test.js'), null, 'a missing file is not short');
  assert.equal(await explicitCheckFiles(root, named, { env: { ...process.env, NODE_OPTIONS: '--trace-warnings' } }), null, 'NODE_OPTIONS is not short');
  const head = runFixtureChild('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(head.status, 0, head.stderr);
  assert.deepEqual(await explicitCheckFiles(root, named, { commit: head.stdout.trim() }), ['packages/gate/tests/io/main/resource.test.js'], 'a review reads the files from the submitted tree');
});

test('gate.io-main-resource.short-slots-behave-the-same-with: short slots behave the same with gate.browserByLaunch on [C7]', async () => {
  // With gate.browserByLaunch on, the runner adds its launch guard to NODE_OPTIONS for its children (#808). The
  // short-slot offer for the same named file must match under either setting: each run gets the environment the
  // runner gives its children for that setting, and both name the file. A foreign NODE_OPTIONS still refuses.
  const { explicitCheckFiles } = await import(BROWSER_ADMISSION_MODULE);
  const root = process.cwd();
  const named = `${quote(process.execPath)} apps/cli/src/io/run/tests.js packages/gate/tests/io/main/resource.test.js`;
  const guard = pathToFileURL(resolve(root, 'packages/gate/src/io/browser/guard.js')).href;
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_OPTIONS'));
  assert.deepEqual(await explicitCheckFiles(root, named, { env: base }), ['packages/gate/tests/io/main/resource.test.js'], 'with gate.browserByLaunch off');
  assert.deepEqual(await explicitCheckFiles(root, named, { env: { ...base, NODE_OPTIONS: `--import=${guard}` } }), ['packages/gate/tests/io/main/resource.test.js'], 'with gate.browserByLaunch on');
  assert.equal(await explicitCheckFiles(root, named, { env: { ...base, NODE_OPTIONS: '--import=file:///elsewhere/unclassified.js' } }), null, 'a foreign NODE_OPTIONS is not short');
});

test('gate.io-main-resource.a-focused-run-queues-behind-a: a focused run queues behind a held gate slot [Q4,C7]', async () => {
  const box = fixture();
  const release = join(box.dir, 'release-focused-holder');
  const holderRoot = gateRepo(box, 'focused-holder', 0.1, release);
  const suiteRoot = probeSuite(box, 'focused-suite');
  const marker = join(box.dir, 'focused-suite.started');
  setOneGateSlot(box, holderRoot);
  const holder = launch(box, holderRoot);
  await withNestedGroup(async add => {
    let focusedRun;
    try {
      await waitFor(() => events(box).includes('focused-holder start'), 'the fixture gate to hold its only machine slot');
      focusedRun = add(launchTestRunner(box, suiteRoot, [
        '--test-name-pattern', PROBE_PATTERN,
        '--disable-warning', 'ExperimentalWarning', '--title', 'focused-slot-probe',
        'test/probe.test.js',
      ], marker));
      const outcome = await waitFor(() => { // budget: hang ceiling for the focused runner to announce its actual start state; no throughput claim.
        if (focusedRun.stderrText.includes('waiting for a gate slot:')) return 'waiting';
        if (existsSync(marker)) return 'ran';
        return false;
      }, 'the focused test to queue behind the held machine gate slot', 15_000);
      assert.equal(outcome, 'waiting', 'a named test file is queued even when test options have separate values');
      assert.equal(existsSync(marker), false, 'the focused test does not execute while the original holder owns the only slot');
      assert.deepEqual(events(box), ['focused-holder start'], 'the original gate still owns its slot while the focused run waits');
      writeFileSync(release, 'release\n');
      const focusedResult = await focusedRun.closed;
      assert.equal(focusedResult.code, 0, `${focusedRun.stderrText}${focusedRun.stdoutText}`);
      assert.equal(readFileSync(marker, 'utf8'), '1', 'the focused run propagates its public held-slot marker to the test process');
      assert.deepEqual(events(box), ['focused-holder start', 'focused-holder end'], 'the original holder releases before the focused run proceeds');
    } finally {
      writeFileSync(release, 'release\n');
      await Promise.all([holder, focusedRun].filter(Boolean).map(child => child.closed));
    }
  });
});

test('gate.io-main-resource.a-full-run-nested-under-a: a full run nested under a held gate does not take a second slot [Q4]', async () => {
  const box = fixture();
  const gateRoot = gateRepo(box, 'nested-full-suite');
  probeSuite(box, 'nested-full-suite');
  const marker = join(box.dir, 'nested-full-suite.started');
  const output = join(box.dir, 'nested-full-suite-runner.log');
  const command = `${quote(process.execPath)} ${quote(RUNNER)} --test-name-pattern ${quote(PROBE_PATTERN)} > ${quote(output)} 2>&1`;
  writeFileSync(join(gateRoot, 'pullboard.json'), JSON.stringify({ gate: command }));
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: gateRoot, env: box.env }).status, 0);
  const policyCommit = spawnSync('git', ['commit', '-q', '-m', 'chore: add nested runner probe'], { cwd: gateRoot, env: box.env, encoding: 'utf8' });
  assert.equal(policyCommit.status, 0, policyCommit.failure ?? policyCommit.stderr);
  setOneGateSlot(box, gateRoot);
  const nestedGate = launch({ ...box, env: { ...box.env, [PROBE_PATH_ENV]: marker } }, gateRoot);
  try {
    const outcome = await waitFor(() => { // budget: hang ceiling for the nested runner marker handshake; no throughput claim.
      if (existsSync(marker)) return 'completed';
      if (existsSync(output) && readFileSync(output, 'utf8').includes('waiting for a gate slot:')) return 'queued';
      return false;
    }, 'the nested runner to complete or expose a second-slot wait', 15_000);
    const runnerOutput = existsSync(output) ? readFileSync(output, 'utf8') : '';
    assert.equal(outcome, 'completed', `the child must inherit the held parent slot, not wait on its own slot; output=${runnerOutput}`);
    assert.equal(readFileSync(marker, 'utf8'), '1', 'the nested test child inherited the actual parent-held-slot marker');
    const result = await nestedGate.closed;
    assert.equal(result.code, 0, `${nestedGate.stderrText}${nestedGate.stdoutText}`);
  } finally {
    if (nestedGate.exitCode === null && nestedGate.signalCode === null) {
      try { process.kill(-nestedGate.pid, 'SIGKILL'); } catch { /* The gate already exited. */ }
    }
    await nestedGate.closed;
  }
});
