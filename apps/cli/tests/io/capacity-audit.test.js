/** The capacity audit reports agents, runners and jobs per runner from recorded data, and only reads [C7,U151]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { auditCapacity } from '../../src/io/capacity-audit.js';
import { stepLine } from '../../src/io/capacity-audit.js';
import { createE2eHelpers } from '../fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const HOUR = 3_600_000;
const fromMs = Date.parse('2026-11-10T00:00:00Z');
const toMs = fromMs + 10 * HOUR;

/** Every machine settings file under a folder, read now, so two reads can be compared. */
function settingsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? settingsFiles(join(dir, entry.name)) : /^settings.*\.json$/u.test(entry.name) ? [[join(dir, entry.name), readFileSync(join(dir, entry.name), 'utf8')]] : []));
}

test('cli.io-capacity-audit.the-audit-counts-agents-runners-and-jobs: clause 1: the audit counts agents, runners and jobs per runner from recorded claims, landings and gate receipts, and names the binding constraint [C7,U151]', () => {
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

test('cli.io-capacity-audit.a-board-with-too-little-data-reports: clause 2: a board with too little data reports unknown with the missing input named, never a typed default [C7,U151]', async () => {
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

test('cli.io-capacity-audit.the-audit-only-reads-so-machine-settings: clause 3: the audit only reads, so machine settings and the inputs are unchanged after it runs [C7,U151]', async () => {
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

const busy = { claims: [{ seat: 'a', at: fromMs }], landings: 1, runs: [{ runner: 'r1', ms: 9 * HOUR, at: fromMs }, { runner: 'r2', ms: 9 * HOUR, at: fromMs }], fromMs, toMs };

test('cli.io-capacity-audit.runner-jobs-step-at-ninety-percent: clause 1: auditCapacity names the one runner.jobs step, from the median reported slots to one more, once mean gate jobs in flight per runner reach 90% of them, and no step below that [C7,U151]', () => {
  const audit = auditCapacity({ ...busy, slots: [1, 1, 5] });
  assert.equal(audit.jobsPerRunner.value, 0.9, 'two runners busy 9h of 10h each');
  assert.deepEqual([audit.step.knob, audit.step.from, audit.step.to], ['runner.jobs', 1, 2]);
  assert.match(audit.step.reason, /0\.900 gate jobs in flight per runner reached 90% of the median 1 reported slots/u);
  const below = auditCapacity({ ...busy, slots: [2, 2] });
  assert.equal(below.step, null, '0.9 in flight is under 90% of 2 slots');
  assert.equal(below.stepMissing, undefined);
  assert.equal(auditCapacity({ ...busy, slots: [2, 3] }).step, null, 'the median of two is the floor of their mean');
});

test('cli.io-capacity-audit.no-step-without-reported-slots: clause 2: with no runner reporting slots, auditCapacity returns no step and names the missing input, reported slots [C7,U151]', () => {
  const audit = auditCapacity(busy);
  assert.equal(audit.step, null);
  assert.deepEqual(audit.stepMissing, ['reported slots']);
  assert.deepEqual(auditCapacity({ claims: [], landings: 0, runs: [], fromMs, toMs, slots: [2] }).stepMissing, ['jobs per runner']);
  assert.equal(stepLine(audit), 'step: none (missing: reported slots)');
});

test('cli.io-capacity-audit.run-audit-prints-the-step-and-writes-nothing: clause 3: runAudit prints the step line, carries it in the JSON result, and leaves the board and machine settings unwritten [C7,U151]', async () => {
  assert.equal(stepLine(auditCapacity({ ...busy, slots: [1] })), 'step: runner.jobs 1 -> 2 (0.900 gate jobs in flight per runner reached 90% of the median 1 reported slots); nothing changed');
  const box = e2e.project();
  const machine = join(box.dir, 'machine-home');
  const settings = settingsFiles(machine);
  const file = join(box.repo, '.git/pullboard/board.sqlite');
  assert.equal((await box.runLocal(box.repo, 'capacity', '--audit')).code, 0, 'the first read opens the board');
  const board = readFileSync(file);
  const json = await box.runLocal(box.repo, 'capacity', '--audit', '--json');
  assert.equal(json.code, 0, json.err);
  const { audit } = JSON.parse(json.out);
  assert.equal(audit.step, null);
  assert.deepEqual(audit.stepMissing, ['reported slots', 'jobs per runner']);
  const text = await box.runLocal(box.repo, 'capacity', '--audit');
  assert.match(text.out, /^step: none \(missing: reported slots, jobs per runner\)$/mu);
  assert.deepEqual(settingsFiles(machine), settings);
  assert.ok(readFileSync(file).equals(board), 'the board file reads byte-identical afterwards');
});
