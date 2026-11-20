/** Real gates and item checks share the machine queue; landing priority and lease behavior stay intact [Q1,Q2,Q4,O5,O6,V18]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { fixture } from '../../fixtures/resource.js';
import { probeSuite } from '../../fixtures/resource.js';
import { withNestedGroup } from '../../../heavy.js';
import { launchTestRunner } from '../../fixtures/resource.js';
import { gateRepo } from '../../fixtures/resource.js';
import { waitFor } from '../../fixtures/resource.js';
import { events } from '../../fixtures/resource.js';
import { PROBE_PATTERN } from '../../fixtures/resource.js';
import { PROBE_WRITE_TARGET_ENV } from '../../fixtures/resource.js';
import { PROBE_WRITE_READY_ENV } from '../../fixtures/resource.js';
import { PROBE_WRITE_RELEASE_ENV } from '../../fixtures/resource.js';
import { launch } from '../../fixtures/resource.js';
import { setOneGateSlot } from '../../fixtures/resource.js';
import { launchDiagnostic } from '../../fixtures/resource.js';
import { reapFixtures } from '../../fixtures/resource.js';

after(reapFixtures);

test('gate.io-main-resource.q1-q2-an-older-diagnostic-stays: [Q1,Q2] an older diagnostic stays ahead of a later ordinary gate', async () => {
  const box = fixture();
  const holderRelease = join(box.dir, 'release-diagnostic-holder');
  const diagnosticRelease = join(box.dir, 'release-diagnostic');
  const diagnosticStarted = join(box.dir, 'older-diagnostic.started');
  const diagnosticWaiting = join(box.dir, 'older-diagnostic.waiting');
  const holderRoot = gateRepo(box, 'diagnostic-holder', 0.1, holderRelease);
  const ordinaryRoot = gateRepo(box, 'later-ordinary-gate', 0.1);
  setOneGateSlot(box, holderRoot);
  const holder = launch(box, holderRoot);
  let diagnostic;
  let ordinary;
  try {
    await waitFor(() => events(box).includes('diagnostic-holder start'), 'the holder to acquire the only gate slot');
    diagnostic = launchDiagnostic(box, holderRoot, 'older-diagnostic', diagnosticStarted, diagnosticRelease, diagnosticWaiting);
    await waitFor(() => existsSync(diagnosticWaiting) || diagnostic.exitCode !== null, 'the older diagnostic to enter the queue');
    assert.equal(readFileSync(diagnosticWaiting, 'utf8'), '1', 'diagnostic is first in the waiting line');
    ordinary = launch(box, ordinaryRoot);
    await waitFor(() => ordinary.stdoutText.includes('place 2') || ordinary.exitCode !== null, 'the later ordinary gate to join behind the diagnostic');
    assert.ok(ordinary.stdoutText.includes('place 2'), 'the ordinary gate is physically second in the queue');
    writeFileSync(holderRelease, 'release\n');
    await waitFor(() => existsSync(diagnosticStarted), 'the older diagnostic to acquire the released slot');
    assert.equal(events(box).includes('later-ordinary-gate start'), false, 'the later ordinary gate stays queued while diagnostics hold the slot');
    writeFileSync(diagnosticRelease, 'release\n');
    await waitFor(() => events(box).includes('later-ordinary-gate start'), 'the ordinary gate to start after diagnostics release');
    const [holderResult, diagnosticResult, ordinaryResult] = await Promise.all([holder.closed, diagnostic.closed, ordinary.closed]);
    assert.equal(holderResult.code, 0, holder.stderrText);
    assert.equal(diagnosticResult.code, 0, diagnostic.stderrText + diagnostic.stdoutText);
    assert.equal(ordinaryResult.code, 0, ordinary.stderrText);
    assert.deepEqual(events(box), ['diagnostic-holder start', 'diagnostic-holder end', 'later-ordinary-gate start', 'later-ordinary-gate end']);
  } finally {
    writeFileSync(holderRelease, 'release\n');
    writeFileSync(diagnosticRelease, 'release\n');
    await Promise.all([holder, diagnostic, ordinary].filter(Boolean).map(child => child.closed));
  }
});

test('gate.io-main-resource.a-raw-full-suite-run-takes: a raw full-suite run takes a machine gate slot [Q4]', async () => {
  const modes = [
    [],
    ['--test-name-pattern', PROBE_PATTERN, '--test-reporter', 'tap', '--test-concurrency', '1', '--test-shard', '1/1', '--experimental-test-isolation', 'process'],
    ['--disable-warning', 'ExperimentalWarning', '--title', 'pullboard-slot-probe', '--max-http-header-size', '16384'],
  ];
  for (const args of modes) {
    await withNestedGroup(async add => {
      const box = fixture();
      const release = join(box.dir, 'release-full-suite-holder');
      const releaseProbe = join(box.dir, 'release-running-probe');
      const holderRoot = gateRepo(box, 'full-suite-holder', 0.1, release);
      const nextRoot = gateRepo(box, 'after-full-suite');
      const suiteRoot = probeSuite(box, 'raw-full-suite');
      const marker = join(box.dir, 'raw-full-suite.started');
      setOneGateSlot(box, holderRoot);
      const holder = launch(box, holderRoot);
      let fullRun;
      let followingGate;
      try {
        await waitFor(() => events(box).includes('full-suite-holder start'), 'the fixture gate to hold its only machine slot');
        fullRun = add(launchTestRunner(box, suiteRoot, args, marker, releaseProbe, { PULLBOARD_LANDING_RUN: '1' }));
        const outcome = await waitFor(() => { // budget: hang ceiling for the raw runner to announce its actual queue state; no throughput claim.
          if (fullRun.stderrText.includes('waiting for a gate slot:')) return 'waiting';
          if (existsSync(marker)) return 'ran';
          return false;
        }, 'the raw full runner to announce its queued slot', 15_000);
        assert.equal(outcome, 'waiting', 'both bare and option-only discovery must queue without a test file');
        assert.match(fullRun.stderrText, /waiting for a gate slot: 1 of 1 in use/u);
        assert.equal(existsSync(marker), false, 'the probe has not run while the other process owns the slot');
        writeFileSync(release, 'release\n');
        assert.equal((await holder.closed).code, 0, holder.stderrText);
        await waitFor(() => existsSync(marker), 'the admitted full-suite probe to start');
        assert.equal(readFileSync(marker, 'utf8'), '1', 'the runner marks its child only after acquiring its machine slot');
        followingGate = launch(box, nextRoot);
        const holding = await waitFor(() => {
          if (followingGate.stdoutText.includes('gate waiting:')) return 'waiting';
          if (events(box).includes('after-full-suite start')) return 'ran';
          return false;
        }, 'the following gate to wait for the full test process');
        assert.equal(holding, 'waiting', 'the full runner holds its slot until its test process exits');
        assert.equal(events(box).includes('after-full-suite start'), false);
        writeFileSync(releaseProbe, 'release\n');
        const [fullResult, followingResult] = await Promise.all([fullRun.closed, followingGate.closed]);
        assert.equal(fullResult.code, 0, `${fullRun.stderrText}${fullRun.stdoutText}`);
        assert.equal(followingResult.code, 0, `${followingGate.stderrText}${followingGate.stdoutText}`);
        assert.equal((fullRun.stderrText.match(/waiting for a gate slot:/g) ?? []).length, 1, 'one wait line per full run');
      } finally {
        writeFileSync(release, 'release\n');
        writeFileSync(releaseProbe, 'release\n');
        await Promise.all([holder, fullRun, followingGate].filter(Boolean).map(child => child.closed));
      }
    });
  }
});

test('gate.io-main-resource.the-slot-probe-s-marker-is: the slot probe\'s marker is never seen half-written [Q4]', async () => {
  const box = fixture();
  const root = probeSuite(box, 'atomic-marker');
  const marker = join(box.dir, 'atomic-marker.started');
  const ready = join(box.dir, 'atomic-marker.write-ready');
  const release = join(box.dir, 'atomic-marker.write-release');
  const preload = join(box.dir, 'pause-probe-write.cjs');
  writeFileSync(preload, `const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const target = process.env.${PROBE_WRITE_TARGET_ENV};
const ready = process.env.${PROBE_WRITE_READY_ENV};
const release = process.env.${PROBE_WRITE_RELEASE_ENV};
const originalWriteFileSync = fs.writeFileSync;
let paused = false;
/** Pause the probe after creating its marker path but before writing its value. */
fs.writeFileSync = function pauseProbeWrite(file, data, options) {
  const path = String(file);
  if (!paused && (path === target || path === target + '.tmp')) {
    paused = true;
    const fd = fs.openSync(path, 'w');
    originalWriteFileSync.call(fs, ready, 'ready');
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    try {
      if (!fs.existsSync(release)) throw new Error('parent did not release delayed probe write');
      return fs.writeSync(fd, data, 0, typeof options === 'string' ? options : options?.encoding ?? 'utf8');
    } finally { fs.closeSync(fd); }
  }
  return originalWriteFileSync.apply(this, arguments);
};
syncBuiltinESMExports();
`);
  const env = {
    [PROBE_WRITE_TARGET_ENV]: marker,
    [PROBE_WRITE_READY_ENV]: ready,
    [PROBE_WRITE_RELEASE_ENV]: release,
    NODE_OPTIONS: `${box.env.NODE_OPTIONS ? `${box.env.NODE_OPTIONS} ` : ''}--require=${JSON.stringify(preload)}`,
  };
  const runner = launchTestRunner(box, root, [], marker, null, env);
  let assertionError;
  try {
    await waitFor(() => existsSync(ready), 'the probe write to pause after creating its destination', 30_000); // budget: hang ceiling for the private paused-write marker handshake; no throughput claim.
    if (existsSync(marker)) assert.equal(readFileSync(marker, 'utf8'), '1', 'a visible marker already has its complete slot value');
  } catch (error) {
    assertionError = error;
  } finally {
    writeFileSync(release, 'release\n');
    const result = await runner.closed;
    assert.equal(result.code, 0, `${runner.stderrText}${runner.stdoutText}`);
  }
  if (assertionError) throw assertionError;
  await waitFor(() => existsSync(marker), 'the atomically published probe marker');
  assert.equal(readFileSync(marker, 'utf8'), '1', 'the final marker contains the complete slot value');
});
