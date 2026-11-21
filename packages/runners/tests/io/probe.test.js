/** Waiting gate processes share one runner probe: single flight, a 15 s shared result and a 60 s failure backoff [C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { refreshRunnerMeasurements } from '../../src/io/slots.js';
import { probeRunnerTransport } from '../../index.js';
import { validateRunner } from '../../../config/index.js';
import { matchesExecutionContext } from '../../../drive/index.js';
import { runnerServiceInstaller } from '../../src/io/service.js';

test('runners.probe.pull-runtime-pin: clause 1: authenticated enrollment pins the service Node bytes and missing or replaced binaries cannot match [C7,#12651]', { timeout: 30_000 }, async t => {
  const home = probes(t);
  const ssh = (args, options) => spawn('/bin/sh', ['-c', args.at(-1)], { ...options, env: { ...options.env, HOME: home, PULLBOARD_MACHINE_HOME: home } });
  const observed = await probeRunnerTransport({ host: 'fixture', node: process.execPath }, { enrollSigningKey: true, spawn: ssh, timeoutMs: 20_000 });
  assert.equal(observed.healthy, true);
  assert.equal(observed.nodePath, process.execPath, 'installer is launched with this resolved executable');
  assert.equal(observed.runtimeSha256, createHash('sha256').update(readFileSync(process.execPath)).digest('hex'));
  const runner = validateRunner({ host: 'fixture', slots: 1, browser: 0, node: observed.nodePath, publicKey: observed.publicKey, runtimeSha256: observed.runtimeSha256 });
  assert.equal(runner.runtimeSha256, observed.runtimeSha256, 'controller enrollment retains the pin beside its identity');
  const bin = join(home, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, 'launchctl'), 0o755);
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME }, stdin = Object.getOwnPropertyDescriptor(process, 'stdin'), write = process.stdout.write;
  const plan = { label: 'fixture.pullboard', root: join(home, 'root'), board: 'http://127.0.0.1:1/api/v1/boards/b', key: 'fixture', entry: 'svc.cjs', files: { 'svc.cjs': '// fixture\n' } };
  let reply = '';
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, HOME: home });
  Object.defineProperty(process, 'stdin', { value: Readable.from([Buffer.from(JSON.stringify(plan))]), configurable: true });
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk === 'string' && chunk.startsWith('{"installed"')) { reply += chunk; return true; } return write.call(process.stdout, chunk, ...rest); };
  try { await runnerServiceInstaller(); } finally { Object.assign(process.env, saved); Object.defineProperty(process, 'stdin', stdin); process.stdout.write = write; }
  const plist = readFileSync(JSON.parse(reply).plist, 'utf8');
  assert.ok(plist.includes(`<string>${observed.nodePath}</string>`), 'installer uses the same resolved Node');
  const tooling = 'a'.repeat(64), expected = { version: 1, runtime: runner.runtimeSha256, tooling };
  assert.equal(matchesExecutionContext({ version: 1, runtime: observed.runtimeSha256, tooling }, expected), true);
  assert.equal(matchesExecutionContext({ version: 1, runtime: 'b'.repeat(64), tooling }, expected), false, 'changed bytes at the same path fail');
  assert.equal(matchesExecutionContext({ version: 1, runtime: observed.runtimeSha256, tooling }, { version: 1, tooling }), false, 'legacy missing pin cannot authenticate');
  assert.equal(validateRunner({ host: 'legacy', slots: 1, browser: 0 }).host, 'legacy', 'legacy runners remain usable');
});

const SLOTS = new URL('../../src/io/slots.js', import.meta.url).href;
const SETTINGS = { gate: { loadAwareDispatch: true }, runners: [{ host: 'runner-a' }, { host: 'runner-b' }] };
const HEALTHY = { healthy: true, cores: 8, memoryMB: 16_384, gui: true, cpuLoad: { load1: 1, at: new Date().toISOString() } };

/** A private probe directory per test, so no shared result leaks between cases. */
function probes(t) {
  const directory = privateFixtureFiles('pb-probe-').root;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A counting fake transport: every call is one probe that would have opened SSH. */
function counting(result = HEALTHY) {
  const calls = [];
  return { calls, measure: async (runner, options) => { calls.push({ host: runner.host, ...options }); if (result instanceof Error) throw result; return result; } };
}

test('runners.probe.n10-concurrent-waiting-gate-processes-start: 10 concurrent waiting gate processes start one probe per runner and share its result [C7]', async t => {
  const directory = probes(t), log = join(directory, 'calls.log'), recorded = join(directory, 'recorded.log');
  const child = `import { appendFileSync } from 'node:fs';
import { refreshRunnerMeasurements } from ${JSON.stringify(SLOTS)};
await refreshRunnerMeasurements(${JSON.stringify(SETTINGS)}, {
  probeDirectory: ${JSON.stringify(join(directory, 'shared'))},
  measure: async runner => { appendFileSync(${JSON.stringify(log)}, runner.host + '\\n'); await new Promise(done => setTimeout(done, 400)); return ${JSON.stringify(HEALTHY)}; },
  record: (host, facts) => appendFileSync(${JSON.stringify(recorded)}, host + ':' + facts.cores + '\\n') });`;
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
  const shared = readFileSync(recorded, 'utf8').trim().split('\n');
  assert.equal(shared.filter(line => line === 'runner-a:8').length, 10, 'every waiter ends with runner-a measured facts');
  assert.equal(shared.filter(line => line === 'runner-b:8').length, 10, 'every waiter ends with runner-b measured facts');
});

test('runners.probe.a-shared-result-is-reused-for: a shared result is reused for 15 s, then the next waiter probes again [C7]', async t => {
  const probeDirectory = probes(t), fake = counting(), now = Date.parse('2026-11-04T22:00:00Z');
  const recorded = [];
  const record = host => recorded.push(host);
  await refreshRunnerMeasurements(SETTINGS, { measure: fake.measure, record, now, probeDirectory });
  assert.equal(fake.calls.length, 2);
  await Promise.all(Array.from({ length: 10 }, () => refreshRunnerMeasurements(SETTINGS, { measure: fake.measure, record, now: now + 14_000, probeDirectory })));
  assert.equal(fake.calls.length, 2, 'waiters inside 15 s share the recorded result');
  await refreshRunnerMeasurements(SETTINGS, { measure: fake.measure, record, now: now + 15_000, probeDirectory });
  assert.equal(fake.calls.length, 4);
  assert.equal(recorded.filter(host => host === 'runner-a').length, 12, '2 probes plus 10 waiters sharing the first result');
  assert.equal(recorded.filter(host => host === 'runner-b').length, 12);
});

test('runners.probe.a-failed-probe-backs-that-runner: a failed probe backs that runner off for at least 60 s [C7]', async t => {
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

test('runners.probe.a-recorded-measurement-younger-than-15: a recorded measurement younger than 15 s is used without probing [C7]', async t => {
  const probeDirectory = probes(t), fake = counting(), now = Date.parse('2026-11-04T22:00:00Z');
  const fresh = new Date(now - 14_999).toISOString(), stale = new Date(now - 15_000).toISOString();
  await refreshRunnerMeasurements({ gate: { loadAwareDispatch: true }, runners: [{ host: 'fresh', cpuLoad: { at: fresh } }, { host: 'stale', cpuLoad: { at: stale } }] },
    { measure: fake.measure, record: () => {}, now, probeDirectory });
  assert.deepEqual(fake.calls.map(call => call.host), ['stale']);
});

test('runners.probe.a-probe-claim-left-by-a: a probe claim left by a dead process is taken over once stale, never while fresh [C7]', async t => {
  const probeDirectory = probes(t), now = Date.parse('2026-11-04T22:00:00Z');
  const settings = { gate: { loadAwareDispatch: true }, runners: [{ host: 'runner-a' }] };
  let release;
  const hung = { measure: () => new Promise(done => { release = () => done(HEALTHY); }) };
  const first = refreshRunnerMeasurements(settings, { measure: hung.measure, record: () => {}, now, probeDirectory, waitMs: 0 });
  const fake = counting();
  await refreshRunnerMeasurements(settings, { measure: fake.measure, record: () => {}, now: now + 30_000, probeDirectory, waitMs: 0 });
  assert.equal(fake.calls.length, 0, 'an in-flight probe is not duplicated');
  await refreshRunnerMeasurements(settings, { measure: fake.measure, record: () => {}, now: now + 61_000, probeDirectory, waitMs: 0 });
  assert.equal(fake.calls.length, 1, 'a dead claim does not block the runner forever');
  release();
  await first;
});

test('runners.probe.a-just-created-claim-with-no: a just-created claim with no owner record yet is held, so an interleaved second process starts no probe [C7]', async t => {
  const probeDirectory = probes(t), now = Date.now();
  const settings = { gate: { loadAwareDispatch: true }, runners: [{ host: 'runner-a' }] };
  const lock = join(probeDirectory, `${createHash('sha256').update('runner-a').digest('hex').slice(0, 24)}.lock`);
  writeFileSync(lock, '');
  const fake = counting();
  await refreshRunnerMeasurements(settings, { measure: fake.measure, record: () => {}, now, probeDirectory, waitMs: 0 });
  assert.equal(fake.calls.length, 0, 'an empty fresh claim is held, not stale');
  const old = new Date(now - 61_000);
  utimesSync(lock, old, old);
  await refreshRunnerMeasurements(settings, { measure: fake.measure, record: () => {}, now, probeDirectory, waitMs: 0 });
  assert.equal(fake.calls.length, 1, 'an empty claim older than the stale interval is taken over');
});
