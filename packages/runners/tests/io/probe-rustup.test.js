/** @pullboard-test-input source-cell runners */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverToolchains } from '../../src/io/probe.js';

const CARGO = '/opt/homebrew/opt/rustup/bin/cargo';
const MISSING = () => ({ status: null, error: Object.assign(new Error('not found'), { code: 'ENOENT' }) });

/** A spawn stub with the named commands answering and every other command missing; records each call. */
function stub(answers, calls) {
  return (name, args) => {
    calls.push([name, ...args].join(' '));
    const answer = answers[[name, ...args].join(' ')];
    return answer === undefined ? MISSING() : { status: 0, stdout: answer, stderr: '' };
  };
}

test('runners.probe-rustup.finds-cargo-through-rustup: clause 1: with cargo missing from PATH but rustup which cargo answering a path, discoverToolchains records cargo with that version [C7]', () => {
  const calls = [];
  const found = discoverToolchains({ spawn: stub({ 'rustup which cargo': `${CARGO}\n`, [`${CARGO} --version`]: 'cargo 1.98.1 (abc 2026-01-01)' }, calls) });
  assert.deepEqual(found, { cargo: '1.98.1' });
  assert.ok(calls.includes('rustup which cargo'));
});

test('runners.probe-rustup.path-answer-wins: clause 2: with cargo on PATH the PATH answer wins and rustup is not asked [C7]', () => {
  const calls = [];
  const found = discoverToolchains({ spawn: stub({ 'cargo --version': 'cargo 1.79.0 (abc 2024-06-10)', 'rustup which cargo': CARGO, [`${CARGO} --version`]: 'cargo 1.98.1' }, calls) });
  assert.deepEqual(found, { cargo: '1.79.0' });
  assert.equal(calls.some(call => call.startsWith('rustup')), false);
});

test('runners.probe-rustup.neither-leaves-out: clause 3: with neither a PATH cargo nor a rustup answer, cargo is left out [C7]', () => {
  assert.deepEqual(discoverToolchains({ spawn: stub({}, []) }), {});
  assert.deepEqual(discoverToolchains({ spawn: stub({ 'rustup which cargo': 'relative/cargo' }, []) }), {});
  assert.deepEqual(discoverToolchains({ spawn: stub({ 'rustup which cargo': CARGO }, []) }), {});
});
