/** @pullboard-test-input source-cell runners */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { discoverToolchains } from '../../src/io/probe.js';
import { probeRunnerTransport } from '../../src/io/probe.js';

const ANSWERS = { python3: 'Python 3.12.4', go: 'go version go1.22.1 darwin/arm64', cargo: 'cargo 1.79.0 (abc 2024-06-10)', ruby: 'ruby 3.3.1 (2024)' };

/** A spawn stub that answers the names in `answers`, fails `failing` and throws for `timing`. */
function stub({ answers = ANSWERS, failing = [], timing = [] } = {}) {
  return (name) => {
    if (timing.includes(name)) return { status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
    if (failing.includes(name)) return { status: 1, stdout: '', stderr: 'boom' };
    if (answers[name] === undefined) return { status: null, error: Object.assign(new Error('not found'), { code: 'ENOENT' }) };
    return { status: 0, stdout: answers[name], stderr: '' };
  };
}

test('runners.probe-discover.asks-each-name: clause 1: discoverToolchains asks each fixed name for its version through the injected spawn and returns name to version for those that answer [C7]', () => {
  const asked = [];
  const spawn = (name, args, options) => { asked.push([name, args[0], options.timeout]); return stub()(name); };
  assert.deepEqual(discoverToolchains({ spawn }), { python3: '3.12.4', go: '1.22.1', cargo: '1.79.0', ruby: '3.3.1' });
  assert.deepEqual(asked.map(([name]) => name), ['python3', 'go', 'cargo', 'ruby', 'swift', 'java', 'mvn', 'gradle', 'deno', 'bun', 'php', 'mix', 'dotnet', 'cmake', 'ctest']);
  assert.deepEqual(asked.find(([name]) => name === 'go').slice(1), ['version', 1500]);
});

test('runners.probe-discover.leaves-out-silent: clause 2: a name whose command is missing, fails, times out or throws is left out, never recorded empty [C7]', () => {
  const spawn = (name, args, options) => {
    if (name === 'ruby') throw new Error('spawn exploded');
    return stub({ failing: ['cargo'], timing: ['go'], answers: { ...ANSWERS, swift: 'no digits here' } })(name, args, options);
  };
  const found = discoverToolchains({ spawn });
  assert.deepEqual(found, { python3: '3.12.4' });
  for (const value of Object.values(found)) assert.notEqual(value, '');
});

test('runners.probe-discover.no-toolchains-as-today: clause 3: probeRunnerTransport with no toolchains declared behaves exactly as today and reports none [C7]', async () => {
  let args;
  const spawn = (given) => {
    args = given;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => { child.stdout.emit('data', 'not json'); child.emit('close', 0, null); });
    return child;
  };
  const result = await probeRunnerTransport({ host: 'runner.local' }, { spawn });
  assert.equal(result.healthy, false);
  assert.equal('toolchains' in result, false);
  assert.ok(!args.at(-1).includes('tcRun'), 'the remote script carries no toolchain check');
});
