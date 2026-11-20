/** The clock table gives every non-terminal item state an owner, a deadline and a default move, and unknown evidence waits one deadline at most [B4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOCK_TABLE } from '../../../light.js';
import { clockRow } from '../../../light.js';
import { clockDue } from '../../../light.js';

const MINUTE_MS = 60_000;
const RULES = ['gate-deferred', 'gate-unknown', 'claim-idle', 'hold', 'rescope', 'folder', 'ready', 'submitted', 'review', 'waiting'];

test('health.logic-clock-table.every-state-has-a-row: clause 1: [B4,C7] the clock table has ten rows, each with an owner, a deadline, a move and a one-deadline unknown limit, and every non-terminal fact set maps to exactly one row', () => {
  assert.ok(Object.isFrozen(CLOCK_TABLE), 'the table is frozen');
  assert.deepEqual(CLOCK_TABLE.map((row) => row.rule), RULES);
  for (const row of CLOCK_TABLE) {
    assert.ok(Object.isFrozen(row), `${row.rule}: row is frozen`);
    assert.ok(typeof row.state === 'string' && row.state.length > 0, `${row.rule}: names its state`);
    assert.ok(typeof row.owner === 'string' && row.owner.length > 0, `${row.rule}: has an owner`);
    assert.ok(row.deadlineMinutes > 0 || (row.deadlineMinutes === null && typeof row.deadlineFrom === 'string'), `${row.rule}: a positive deadline or the lease or root it inherits`);
    assert.ok(typeof row.move === 'string' && row.move.length > 0, `${row.rule}: has a default move`);
    assert.equal(row.unknownLimit, 1, `${row.rule}: unknown evidence waits one extra deadline`);
  }
  const byRule = Object.fromEntries(CLOCK_TABLE.map((row) => [row.rule, row]));
  assert.deepEqual(
    Object.fromEntries(CLOCK_TABLE.map((row) => [row.rule, [row.owner, row.deadlineMinutes ?? row.deadlineFrom, row.move]])),
    {
      'gate-deferred': ['board', 120, 'gate-dead'],
      'gate-unknown': ['submitter', 240, 'release-claim'],
      'claim-idle': ['builder', 30, 'release-claim'],
      hold: ['hold-owner', 1440, 'to-rebar'],
      rescope: ['re-bar-queue', 120, 'to-person'],
      folder: ['board', 10, 'remove-folder'],
      ready: ['builders', 60, 'alarm'],
      submitted: ['runner', 'gate-lease', 'existing'],
      review: ['reviewer', 'review-lease', 'existing'],
      waiting: ['root-owner', 'root-deadline', 'inherit']
    }
  );
  const cases = [
    [{ status: 'open', after: 'landed' }, 'ready'],
    [{ status: 'open' }, 'ready'],
    [{ status: 'claimed' }, 'claim-idle'],
    [{ status: 'submitted' }, 'submitted'],
    [{ status: 'submitted', review: true }, 'review'],
    [{ status: 'open', held: true }, 'hold'],
    [{ status: 'claimed', held: true }, 'hold'],
    [{ status: 'open', rescope: true }, 'rescope'],
    [{ status: 'open', after: 'unlanded' }, 'waiting'],
    [{ status: 'open', gate: 'deferred' }, 'gate-deferred'],
    [{ status: 'claimed', gate: 'unknown' }, 'gate-unknown'],
    [{ status: 'open', folder: 'ended' }, 'folder'],
    [{ status: 'withdrawn', folder: 'ended' }, 'folder']
  ];
  for (const [facts, rule] of cases) {
    const matches = CLOCK_TABLE.filter((row) => row === clockRow(facts));
    assert.equal(matches.length, 1, `${JSON.stringify(facts)}: exactly one row`);
    assert.equal(clockRow(facts), byRule[rule], `${JSON.stringify(facts)} maps to ${rule}`);
  }
  for (const facts of [{ status: 'verified' }, { status: 'withdrawn' }, { status: 'parked' }, {}, undefined]) {
    assert.throws(() => clockRow(facts), /clock: /u, `${JSON.stringify(facts)}: no row covers it, so it throws`);
  }
});

test('health.logic-clock-table.unknown-waits-one-deadline: clause 2: [B4,C7] with a fixed now, idle evidence is due at one deadline, unknown evidence waits until two deadlines, and at two deadlines the move is due whatever the evidence', () => {
  const since = Date.UTC(2026, 10, 20, 12, 0, 0);
  const at = (minutes) => since + minutes * MINUTE_MS;
  for (const evidence of ['active', 'idle', 'unknown']) {
    assert.deepEqual(clockDue({ rule: 'claim-idle', since, evidence }, at(29)), { due: false, deadlineAt: at(30) }, `${evidence}: not due before the deadline`);
  }
  assert.deepEqual(clockDue({ rule: 'claim-idle', since, evidence: 'idle' }, at(30)), { due: true, move: 'release-claim' });
  assert.deepEqual(clockDue({ rule: 'claim-idle', since, evidence: 'unknown' }, at(30)), { due: false, waiting: 'unknown-evidence', deadlineAt: at(60) });
  assert.deepEqual(clockDue({ rule: 'claim-idle', since, evidence: 'unknown' }, at(59)), { due: false, waiting: 'unknown-evidence', deadlineAt: at(60) });
  assert.equal(clockDue({ rule: 'claim-idle', since, evidence: 'active' }, at(45)).due, false, 'active evidence past the deadline is not due');
  for (const evidence of ['active', 'idle', 'unknown']) {
    assert.deepEqual(clockDue({ rule: 'claim-idle', since, evidence }, at(60)), { due: true, move: 'release-claim' }, `${evidence}: due at two deadlines`);
  }
  assert.deepEqual(clockDue({ rule: 'gate-unknown', since, evidence: 'unknown' }, at(480)), { due: true, move: 'release-claim' });
  assert.deepEqual(clockDue({ rule: 'hold', since, evidence: 'unknown' }, at(2880)), { due: true, move: 'to-rebar' }, 'a hold with no recorded deadline uses 1440 minutes');
  assert.deepEqual(clockDue({ rule: 'hold', since, evidence: 'idle', deadlineMinutes: 90 }, at(90)), { due: true, move: 'to-rebar' }, 'a recorded hold deadline wins');
  assert.throws(() => clockDue({ rule: 'submitted', since, evidence: 'idle' }, at(10)), /positive deadline/u, 'an inherited deadline must be passed');
  assert.throws(() => clockDue({ rule: 'claim-idle', since, evidence: 'maybe' }, at(10)), /evidence/u);
  assert.throws(() => clockDue({ rule: 'no-such-rule', since, evidence: 'idle' }, at(10)), /no row/u);
});
