/** pullboard capacity --audit reports agents, runners and jobs per runner from recorded data, and only reads [C7,U151]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { auditCapacity } from '../../../src/io/commands/capacity-audit.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const HOUR = 3_600_000;
const fromMs = Date.parse('2026-11-10T00:00:00Z');
const toMs = fromMs + 10 * HOUR;

/** Every machine settings file under a folder, read now, so two reads can be compared. */
function settingsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? settingsFiles(join(dir, entry.name)) : /^settings.*\.json$/u.test(entry.name) ? [[join(dir, entry.name), readFileSync(join(dir, entry.name), 'utf8')]] : []));
}

test('clause 1: the audit counts agents, runners and jobs per runner from recorded claims, landings and gate receipts, and names the binding constraint [C7,U151]', () => {
  const claims = [{ seat: 'core-1', at: fromMs }, { seat: 'core-2', at: fromMs + HOUR }, { seat: 'core-1', at: fromMs + 2 * HOUR }];
  const runs = [{ runner: 'r1', ms: 2 * HOUR, at: fromMs }, { runner: 'r1', ms: 2 * HOUR, at: fromMs }, { runner: 'r2', ms: HOUR, at: fromMs }];
  const audit = auditCapacity({ claims, landings: 4, runs, fromMs, toMs });
  assert.equal(audit.agents.value, 2);
  assert.equal(audit.runners.value, 2);
  assert.equal(audit.jobsPerRunner.value, 5 * HOUR / (10 * HOUR) / 2);
  assert.equal(audit.binding.kind, 'agents', 'runners have headroom: under one job in flight each');
  assert.equal(auditCapacity({ claims, landings: 4, runs: runs.map(run => ({ ...run, ms: 12 * HOUR })), fromMs, toMs }).binding.kind, 'runners');
  const json = JSON.stringify(audit);
  assert.ok(audit.binding.rule && !json.includes('NaN'));
});

test('clause 2: a board with too little data reports unknown with the missing input named, never a typed default [C7,U151]', async () => {
  const none = auditCapacity({ claims: [], landings: 0, runs: [], fromMs, toMs });
  assert.deepEqual([none.agents.value, none.runners.value, none.jobsPerRunner.value], [null, null, null]);
  assert.deepEqual(none.agents.missing, ['claims']);
  assert.deepEqual(none.runners.missing, ['gate receipts naming a runner']);
  assert.equal(none.binding.kind, 'unknown');
  assert.ok(none.binding.missing.includes('claims') && none.binding.missing.includes('landings'));
  const box = e2e.project();
  const result = await box.runLocal(box.repo, 'capacity', '--audit', '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  const { audit } = JSON.parse(result.out);
  assert.equal(audit.runners.value, null, 'a fresh board has no runner receipt');
  assert.equal(audit.jobsPerRunner.value, null);
  assert.equal(audit.binding.kind, 'unknown');
  const text = await box.runLocal(box.repo, 'capacity', '--audit');
  assert.match(text.out, /^runners: unknown \(missing: gate receipts naming a runner\)$/mu);
});

test('clause 3: the audit only reads, so machine settings and the inputs are unchanged after it runs [C7,U151]', async () => {
  const input = { claims: [{ seat: 'a', at: fromMs }], landings: 1, runs: [{ runner: 'r', ms: HOUR, at: fromMs }], fromMs, toMs };
  const before = JSON.stringify(input);
  const first = auditCapacity(input);
  assert.deepEqual(auditCapacity(input), first, 'repeatable');
  assert.equal(JSON.stringify(input), before);
  const box = e2e.project();
  const machine = join(box.dir, 'machine-home');
  const settings = settingsFiles(machine);
  const result = await box.runLocal(box.repo, 'capacity', '--audit');
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(settingsFiles(machine), settings, 'gateSlots and the runner jobs settings are untouched');
});
