/** A pulled gate's receipt reads back in the inline gate's shape, and a 0.9.3 receipt without those fields reads as absent [P7,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { phaseReceiptId } from '../../index.js';
import { settledGate } from '../../index.js';

const JOB = 'gate:7:abcdefabcdef:mwf0';

test('a receipt with a plan carries files, tiers, phase plan, check, counts, log and its recorded receipts [P7,C7]', () => {
  const recorded = new Set([phaseReceiptId(JOB, 'check'), phaseReceiptId(JOB, 'proof'), phaseReceiptId('gate:other', 'check')]);
  const gate = settledGate(JOB, { runner: 'r1', receipt: { output: { runner: 'r1', folder: '/kept/gate-1' }, gate: { green: true, steps: { analysis: 5, check: 10, proof: 20 },
    phases: [{ role: 'check', status: 0, kept: 'check.log', counts: { passed: 3, failed: 0, skipped: 1 } }, { role: 'proof', status: 0, kept: 'proof.log', counts: { passed: 4, failed: 0, skipped: 0 } }],
    plan: { files: ['test/a.test.js'], testTiers: { packages: ['.'], units: ['test/a.test.js'], journeys: [] }, phasePlan: [{ role: 'criterion', command: 'node check.cjs' }, { role: 'proof', command: 'node --test test/a.test.js' }] } } } }, recorded);
  assert.deepEqual(gate.counts, { passed: 7, failed: 0, skipped: 1 });
  assert.equal(gate.logPath, join('/kept/gate-1', 'proof.log'), 'a green gate names its last phase log');
  assert.equal(gate.logRunner, 'r1');
  assert.deepEqual(gate.files, ['test/a.test.js']);
  assert.deepEqual(gate.testTiers.units, ['test/a.test.js']);
  assert.deepEqual(gate.phasePlan.map(phase => phase.role), ['criterion', 'proof']);
  assert.deepEqual(gate.check, { command: 'node check.cjs', checked: true, green: true });
  assert.deepEqual(gate.profile.steps, { analysis: 5, check: 10, proof: 20 }, 'the phase durations the runner recorded');
  assert.deepEqual(gate.proofReceiptIds, [phaseReceiptId(JOB, 'check'), phaseReceiptId(JOB, 'proof')], 'only this job\'s recorded receipts, check first');
});

test('a red phase names its own log, and a log name that is a path is never joined [P7,C7]', () => {
  const posted = phase => ({ receipt: { output: { folder: '/kept/gate-2' }, gate: { green: false, phases: [{ role: 'check', status: 0, kept: 'check.log' }, phase] } } });
  assert.equal(settledGate(JOB, posted({ role: 'proof', status: 1, kept: 'proof.log' })).logPath, join('/kept/gate-2', 'proof.log'));
  assert.equal(settledGate(JOB, posted({ role: 'proof', status: 1, kept: '../../etc/passwd' })).logPath, join('/kept/gate-2', 'check.log'));
});

test('a 0.9.3 receipt without plan, counts or kept logs reads as it was, with no added fields [P7,C7]', () => {
  const old = { version: 1, green: true, steps: { check: 3 }, phases: [{ role: 'check', status: 0, tail: '# pass 2' }] };
  assert.deepEqual(settledGate(JOB, { receipt: { gate: old } }), old);
  assert.equal(settledGate(JOB, { receipt: {} }), null);
  assert.equal(settledGate(JOB, null), null);
  assert.equal(settledGate(JOB, { receipt: { gate: { phases: 'not a list', plan: [] } } }).files, undefined, 'a malformed plan is absent, not a crash');
});

test('a receipt id is a fixed 36-character id per job and phase [P7]', () => {
  assert.match(phaseReceiptId(JOB, 'check'), /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  assert.equal(phaseReceiptId(JOB, 'check'), phaseReceiptId(JOB, 'check'));
  assert.notEqual(phaseReceiptId(JOB, 'check'), phaseReceiptId(JOB, 'proof'));
});
