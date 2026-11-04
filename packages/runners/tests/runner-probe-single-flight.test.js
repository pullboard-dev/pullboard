/** Waiting gate processes share one runner probe: single flight, a 15 s shared result and a 60 s failure backoff [C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { refreshRunnerMeasurements } from '../src/shell/runner-slots.js';

const SLOTS = new URL('../src/shell/runner-slots.js', import.meta.url).href;
const SETTINGS = { gate: { loadAwareDispatch: true }, runners: [{ host: 'runner-a' }, { host: 'runner-b' }] };
const HEALTHY = { healthy: true, cores: 8, memoryMB: 16_384, gui: true, cpuLoad: { load1: 1, at: new Date().toISOString() } };

/** A private probe directory per test, so no shared result leaks between cases. */
function probes(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pb-probe-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A counting fake transport: every call is one probe that would have opened SSH. */
function counting(result = HEALTHY) {
  const calls = [];
  return { calls, measure: async (runner, options) => { calls.push({ host: runner.host, ...options }); if (result instanceof Error) throw result; return result; } };
}

test('10 concurrent waiting gate processes start one probe per runner and share its result [C7]', async t => {
  const directory = probes(t), log = join(directory, 'calls.log');
  const child = `import { appendFileSync } from 'node:fs';
import { refreshRunnerMeasurements } from ${JSON.stringify(SLOTS)};
await refreshRunnerMeasurements(${JSON.stringify(SETTINGS)}, {
  probeDirectory: ${JSON.stringify(join(directory, 'shared'))},
  measure: async runner => { appendFileSync(${JSON.stringify(log)}, runner.host + '\\n'); await new Promise(done => setTimeout(done, 400)); return ${JSON.stringify(HEALTHY)}; },
  record: () => {} });`;
  const runs = Array.from({ length: 10 }, () => new Promise((done, fail) => {
    const waiter = spawn(process.execPath, ['--input-type=module', '-e', child], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    waiter.stderr.on('data', part => { err += part; });
    waiter.once('error', fail);
    waiter.once('close', code => code === 0 ? done() : fail(new Error(`waiter exited ${code}: ${err}`)));
  }));
  await Promise.all(runs);
  const lines = readFileSync(log, 'utf8').trim().split('\n').sort();
  assert.deepEqual(lines, ['runner-a', 'runner-b'], 'one probe per runner across all 10 waiters');
});

test('a shared result is reused for 15 s, then the next waiter probes again [C7]', async t => {
  const probeDirectory = probes(t), fake = counting(), now = Date.parse('2026-11-04T22:00:00Z');
  const recorded = [];
  const record = (host, facts) => recorded.push(host);
  await refreshRunnerMeasurements(SETTINGS, { measure: fake.measure, record, now, probeDirectory });
  assert.equal(fake.calls.length, 2);
  await Promise.all(Array.from({ length: 10 }, () => refreshRunnerMeasurements(SETTINGS, { measure: fake.measure, record, now: now + 14_000, probeDirectory })));
  assert.equal(fake.calls.length, 2, 'waiters inside 15 s share the recorded result');
  await refreshRunnerMeasurements(SETTINGS, { measure: fake.measure, record, now: now + 15_000, probeDirectory });
  assert.equal(fake.calls.length, 4);
  assert.deepEqual(recorded.sort(), ['runner-a', 'runner-a', 'runner-b', 'runner-b']);
});

test('a failed probe backs that runner off for at least 60 s [C7]', async t => {
  const probeDirectory = probes(t), now = Date.parse('2026-11-04T22:00:00Z');
  const settings = { gate: { loadAwareDispatch: true }, runners: [{ host: 'runner-a' }] };
  const failing = counting(new Error('ssh: connect timed out'));
  await refreshRunnerMeasurements(settings, { measure: failing.measure, record: () => {}, now, probeDirectory });
  assert.equal(failing.calls.length, 1);
  const healthy = counting();
  for (const later of [1_000, 15_000, 30_000, 59_999]) {
    await refreshRunnerMeasurements(settings, { measure: healthy.measure, record: () => {}, now: now + later, probeDirectory });
  }
  assert.equal(healthy.calls.length, 0, 'no attempt inside the backoff');
  await refreshRunnerMeasurements(settings, { measure: healthy.measure, record: () => {}, now: now + 60_000, probeDirectory });
  assert.equal(healthy.calls.length, 1);
  const unhealthy = counting({ healthy: false });
  await refreshRunnerMeasurements(settings, { measure: unhealthy.measure, record: () => {}, now: now + 120_000, probeDirectory });
  await refreshRunnerMeasurements(settings, { measure: unhealthy.measure, record: () => {}, now: now + 150_000, probeDirectory });
  assert.equal(unhealthy.calls.length, 1, 'an unhealthy answer backs off like a failure');
});

test('a recorded measurement younger than 15 s is used without probing [C7]', async t => {
  const probeDirectory = probes(t), fake = counting(), now = Date.parse('2026-11-04T22:00:00Z');
  const fresh = new Date(now - 14_999).toISOString(), stale = new Date(now - 15_000).toISOString();
  await refreshRunnerMeasurements({ gate: { loadAwareDispatch: true }, runners: [{ host: 'fresh', cpuLoad: { at: fresh } }, { host: 'stale', cpuLoad: { at: stale } }] },
    { measure: fake.measure, record: () => {}, now, probeDirectory });
  assert.deepEqual(fake.calls.map(call => call.host), ['stale']);
});

test('a probe claim left by a dead process is taken over once stale, never while fresh [C7]', async t => {
  const probeDirectory = probes(t), now = Date.parse('2026-11-04T22:00:00Z');
  const settings = { gate: { loadAwareDispatch: true }, runners: [{ host: 'runner-a' }] };
  let release;
  const hung = { measure: () => new Promise(done => { release = () => done(HEALTHY); }) };
  const first = refreshRunnerMeasurements(settings, { measure: hung.measure, record: () => {}, now, probeDirectory });
  const fake = counting();
  await refreshRunnerMeasurements(settings, { measure: fake.measure, record: () => {}, now: now + 30_000, probeDirectory });
  assert.equal(fake.calls.length, 0, 'an in-flight probe is not duplicated');
  await refreshRunnerMeasurements(settings, { measure: fake.measure, record: () => {}, now: now + 61_000, probeDirectory });
  assert.equal(fake.calls.length, 1, 'a dead claim does not block the runner forever');
  release();
  await first;
});
