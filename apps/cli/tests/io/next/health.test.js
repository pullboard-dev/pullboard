/** @pullboard-test-input apps/cli/src/io/next/health.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { healthAdviceLines } from '../../../src/io/next/health.js';

const finding = (role, who, title, next) => ({ owner: { role, who }, title, next });
const findings = [
  finding('builder', 'me', 'a claim sits idle', 'release it or submit it'),
  finding('builder', 'other', 'a claim sits idle', 'release it'),
  finding('coordinator', 'me', 'the queue is deep', 'add a runner'),
  finding('builder', 'me', 'a branch is behind', 'merge main'),
];

test('cli.io-next-health.advice-lines: clause 1: with the setting on, one line per finding owned by this builder seat as its title and next step, none for other seats or roles or an empty list [C7,#2330]', () => {
  const lines = healthAdviceLines({}, 'me', { enabled: true, read: () => ({ findings }) });
  assert.deepEqual(lines, ['health: a claim sits idle; release it or submit it', 'health: a branch is behind; merge main']);
  assert.deepEqual(healthAdviceLines({}, 'nobody', { enabled: true, read: () => ({ findings }) }), []);
  assert.deepEqual(healthAdviceLines({}, 'me', { enabled: true, read: () => ({ findings: [] }) }), []);
});

test('cli.io-next-health.advice-off: clause 2: with the setting off or unset no lines come back and the findings are never read [C7,#2330]', () => {
  const calls = [];
  const read = () => { calls.push(1); return { findings }; };
  assert.deepEqual(healthAdviceLines({}, 'me', { enabled: false, read }), []);
  assert.deepEqual(healthAdviceLines({}, 'me', { enabled: 0, read }), []);
  assert.deepEqual(calls, []);
});
