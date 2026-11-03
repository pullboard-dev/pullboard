/** A new or changed gate refusal reports what it would refuse for 20 real gates, then enforces [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLEAN_GATES_TO_ENFORCE } from '../packages/gate/index.js';
import { ENFORCED_REFUSALS } from '../packages/gate/index.js';
import { countTrialGate } from '../packages/gate/index.js';
import { gateRefuse } from '../packages/gate/index.js';
import { recordFalseRefusal } from '../packages/gate/index.js';
import { refusalMode } from '../packages/gate/index.js';

/** A private trial ledger, the gate's output lines, and one real gate whose rule raises `code`. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-refusal-trial-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'refusal-trials.json'), output = [];
  /** Run one gate whose rule would refuse with this code: 'passed', or the refusal it threw. */
  const gate = (code, options = {}) => {
    try {
      gateRefuse(dir, code, 'the fixture case', line => output.push(line), { file, ...options });
      return 'passed';
    } catch (error) { return error.code; } finally { output.push(...countTrialGate(dir, { file })); }
  };
  return { dir, file, output, gate };
}

test('a made-up new refusal code reports "would refuse" and the gate passes, for gates 1 to 20, and refuses at gate 21 [C7]', t => {
  const box = fixture(t);
  assert.equal(CLEAN_GATES_TO_ENFORCE, 20);
  assert.ok(!ENFORCED_REFUSALS.has('FIXTURE_NEW_RULE'), 'the code is new: it was not enforced when the list was frozen');
  for (let number = 1; number <= 20; number++) {
    assert.equal(box.gate('FIXTURE_NEW_RULE'), 'passed', `gate ${number} passes: the new refusal only reports`);
    assert.ok(box.output.includes(`would refuse FIXTURE_NEW_RULE (report-only, ${number - 1}/20 clean gates): the fixture case`), `gate ${number} records what it would refuse`);
  }
  assert.ok(box.output.includes('refusal trial FIXTURE_NEW_RULE: enforce (20/20 clean gates)'), 'the 20th gate records the trial is over');
  assert.equal(box.gate('FIXTURE_NEW_RULE'), 'FIXTURE_NEW_RULE', 'gate 21 refuses');
});

test('a refusal enforced when the list was frozen refuses at once, and a changed one goes back on trial [C7]', t => {
  const box = fixture(t);
  assert.ok(ENFORCED_REFUSALS.has('GATE_RED') && ENFORCED_REFUSALS.size > 500, 'today\'s refusal codes are the enforced baseline');
  assert.equal(box.gate('GATE_RED'), 'GATE_RED');
  assert.equal(box.gate('GATE_RED', { changed: { GATE_RED: '#2611 fixture change' } }), 'passed');
});

test('a recorded false refusal restarts the trial [C7]', t => {
  const box = fixture(t);
  for (let number = 1; number <= 19; number++) box.gate('FIXTURE_NEW_RULE');
  recordFalseRefusal(box.dir, 'FIXTURE_NEW_RULE', { file: box.file });
  assert.deepEqual(refusalMode(box.dir, 'FIXTURE_NEW_RULE', { file: box.file }), { mode: 'report', clean: 0 });
  assert.equal(JSON.parse(readFileSync(box.file, 'utf8')).codes.FIXTURE_NEW_RULE.falseRefusals, 1);
  assert.equal(box.gate('FIXTURE_NEW_RULE'), 'passed');
});

test('a second change to the same refusal starts a fresh twenty-gate trial [C7]', t => {
  const box = fixture(t);
  const first = { changed: { GATE_RED: 'first rule content' } };
  const second = { changed: { GATE_RED: 'second rule content' } };
  for (let number = 1; number <= 20; number++) assert.equal(box.gate('GATE_RED', first), 'passed');
  assert.equal(box.gate('GATE_RED', first), 'GATE_RED');
  for (let number = 1; number <= 20; number++) assert.equal(box.gate('GATE_RED', second), 'passed');
  assert.equal(box.gate('GATE_RED', second), 'GATE_RED');
});
