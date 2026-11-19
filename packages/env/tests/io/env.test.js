/** @pullboard-test-input source-cell packages/env */
/** The environment adapter returns the injected source, or the real one by default, and the kernel gains no export [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as kernel from '../../../kernel/index.js';
import * as kernelLight from '../../../kernel/light.js';
import { environmentAdapter } from '../../index.js';

test('env.adapter.returns-the-source: clause 1: the adapter returns what the injected source returns [C7]', () => {
  const env = environmentAdapter({ A: 'one', B: undefined });
  assert.equal(env.get('A'), 'one');
  assert.equal(env.get('B', 'fb'), 'fb');
  assert.equal(env.has('A'), true);
  assert.equal(env.has('B'), false);
  assert.deepEqual(env.all(), { A: 'one', B: undefined });
});

test('env.adapter.real-by-default: clause 1: the adapter reads the real source by default [C7]', () => {
  const key = 'PULLBOARD_ADAPTER_ENV_PROBE';
  const before = process.env[key];
  process.env[key] = 'real';
  try {
    assert.equal(environmentAdapter().get(key), 'real');
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
});

test('env.adapter.fake-is-deterministic: clause 1: a fake source makes the answer deterministic [C7]', () => {
  const fake = { HOME: '/fake/home' };
  assert.equal(environmentAdapter(fake).get('HOME'), '/fake/home');
  fake.HOME = '/other';
  assert.equal(environmentAdapter(fake).get('HOME'), '/other');
});

test('env.adapter.kernel-gains-no-export: clause 2: the kernel exports no environment adapter, so no existing behaviour changes [C7]', () => {
  assert.equal('environmentAdapter' in kernel, false);
  assert.equal('environmentAdapter' in kernelLight, false);
  assert.equal(typeof environmentAdapter, 'function');
});

test('env.adapter.set-and-delete: clause 1: set and delete change the given source object [C7]', () => {
  const source = { A: 'one' };
  const env = environmentAdapter(source);
  env.set('B', 'two');
  assert.equal(env.get('B'), 'two');
  assert.equal(source.B, 'two');
  env.delete('A');
  assert.equal(env.has('A'), false);
  assert.equal(env.get('A', 'fb'), 'fb');
  assert.equal('A' in source, false);
});

test('env.adapter.set-delete-real-default: clause 2: with no source, set and delete change process.env itself [C7]', () => {
  const key = 'PULLBOARD_ADAPTER_ENV_SET_PROBE';
  const before = process.env[key];
  try {
    const env = environmentAdapter();
    env.set(key, 'written');
    assert.equal(process.env[key], 'written');
    env.delete(key);
    assert.equal(key in process.env, false);
    assert.equal(env.has(key), false);
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
});
