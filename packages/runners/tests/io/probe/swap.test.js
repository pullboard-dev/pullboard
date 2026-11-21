/** @pullboard-test-input source-cell runners */
/** The runner heartbeat probe reports swapUsedMB only when gate.sampleSwap asks for it [C7,#10583]. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { probeRunnerTransport } from '../../../src/io/probe.js';
import { refreshRunnerMeasurements } from '../../../src/io/slots.js';

/** A spawn whose child answers the probe nonce with `cpuLoad` extras and records the remote script. */
function fakeSpawn(seen, swapUsedMB) {
  return (args) => {
    seen.push(args.at(-1));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const nonce = /nonce:"([0-9a-f-]{36})"/u.exec(args.at(-1))?.[1];
    const cpuLoad = { at: new Date().toISOString(), busyPercent: 12.5, average: [1, 2, 3], ...(swapUsedMB === undefined ? {} : { swapUsedMB }) };
    setImmediate(() => { child.stdout.emit('data', JSON.stringify({ nonce, node: '22.13.0', cpuLoad })); child.emit('close', 0, null); });
    return child;
  };
}

test('runners.probe-swap.reports-swap-used: clause 1: probeRunnerTransport with observeLoad and observeSwap returns cpuLoad with swapUsedMB, drops a bad one, and without observeSwap reads no swap [C7]', async () => {
  const seen = [];
  const runner = { host: 'runner.local' };
  const good = await probeRunnerTransport(runner, { observeLoad: true, observeSwap: true, spawn: fakeSpawn(seen, 3600) });
  assert.equal(good.cpuLoad.swapUsedMB, 3600);
  assert.match(seen[0], /vm\.swapusage/u, 'the remote script reads swap');
  for (const bad of [-1, 1.5, '12']) {
    const dropped = await probeRunnerTransport(runner, { observeLoad: true, observeSwap: true, spawn: fakeSpawn([], bad) });
    assert.equal('swapUsedMB' in dropped.cpuLoad, false, `${JSON.stringify(bad)} is dropped`);
  }
  const plain = [];
  const without = await probeRunnerTransport(runner, { observeLoad: true, spawn: fakeSpawn(plain, 3600) });
  assert.deepEqual(Object.keys(without.cpuLoad).sort(), ['at', 'average', 'busyPercent']);
  assert.doesNotMatch(plain[0], /vm\.swapusage|swapUsedMB/u, 'the remote script reads no swap');
});

test('runners.probe-swap.heartbeat-passes-flag: clause 2: refreshRunnerMeasurements passes observeSwap only when settings.gate.sampleSwap is true [C7]', async () => {
  /** Run one refresh with a fake measure and record, and return the options measure was given. */
  async function optionsFor(gate) {
    const given = [];
    const measure = async (runner, options) => { given.push(options); return { healthy: true, cores: 4, memoryMB: 8192, gui: false, cpuLoad: { at: new Date().toISOString(), busyPercent: 1, average: [0, 0, 0] } }; };
    await refreshRunnerMeasurements({ gate: { loadAwareDispatch: true, measuredSlots: true, ...gate }, runners: [{ host: 'runner.local' }] }, { measure, record() {} });
    return given;
  }
  const on = await optionsFor({ sampleSwap: true });
  assert.equal(on.length, 1, 'the heartbeat measured the runner');
  assert.equal(on[0].observeSwap, true);
  for (const gate of [{}, { sampleSwap: false }, { sampleSwap: 'yes' }]) {
    const off = await optionsFor(gate);
    assert.equal(off.length, 1);
    assert.equal('observeSwap' in off[0], false, `${JSON.stringify(gate)} does not ask for swap`);
  }
});
