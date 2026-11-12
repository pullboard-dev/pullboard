/** Real-SQLite replay tests for person row decisions and coordinator apply receipts [B26,H3,H16,S18,S19]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import {
  appliedSequence,
  applyEngineMove,
  engineReceipt,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { AGENT_SHELL_MARKERS } from '../../../../packages/kernel/index.js';

const RECORDED_AT = '2026-10-08T18:00:00.000Z';
const APPLIED_AT = '2026-10-08T18:01:00.000Z';

const DECISIONS = [
  {
    kind: 'spec', file: 'SPEC.md', id: 'G1',
    source: '- G1 [draft, must] Approve this row. | gate: apps/cli/journeys/decisions/row.test.js',
    replacement: '- G1 [approved, must] Approve this row. | gate: apps/cli/journeys/decisions/row.test.js',
    text: 'Approve this row.', decision: 'approve', reason: '',
  },
  {
    kind: 'doctrine', file: 'DOCTRINE.md', id: 'L1',
    source: '- L1 [draft] Decline this rule. | gate: review',
    replacement: '- L1 [wont] The person declined. | gate: review',
    text: 'The person declined.', decision: 'decline', reason: 'The person declined.',
  },
];

/** Open a source board and two native SQLite replicas with divergent ambient clocks. */
function decisionCopies(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-row-decision-replay-'));
  const source = openBoard(':memory:', { now: () => new Date('2026-10-08T12:00:00.000Z') });
  store.register(source, { lane: 'coordinator', path: '/fixture' });
  store.register(source, { lane: 'web', path: '/fixture/web-1' });
  store.addItem(source, { by: 'coordinator', lane: 'web', title: 'Unchanged fixture item' });
  const initial = exportBoard(source);
  const copies = ['person-shell', 'plain-shell'].map((name, index) => {
    const clock = { now: () => new Date(`2026-10-08T${index + 14}:00:00.000Z`) };
    const board = openBoard(':memory:', clock);
    importBoard(board, initial);
    return board;
  });
  t.after(() => {
    for (const board of copies) store.closeBoard(board);
    store.closeBoard(source);
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, source, copies };
}

/** Apply one captured operation to each replica while their process environments differ. */
function replayWithDifferentShells(one, two, move, sequence, at) {
  const original = AGENT_SHELL_MARKERS.map((name) => [name, process.env[name]]);
  try {
    for (const name of AGENT_SHELL_MARKERS) process.env[name] = 'fixture-agent';
    const first = applyEngineMove(one, move, { sequence, at });
    for (const name of AGENT_SHELL_MARKERS) delete process.env[name];
    const second = applyEngineMove(two, move, { sequence, at });
    assert.deepEqual(first, second, 'replicas ignore sender shell markers and use the sealed operation');
    return first;
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('captured person decisions and coordinator apply replay identically without touching checkout files [B26,H3,H16,S18,S19]', (t) => {
  const { directory, source, copies: [one, two] } = decisionCopies(t);
  const sentinel = join(directory, 'SPEC.md');
  writeFileSync(sentinel, 'leave this checkout file alone\n');
  const sentinelBefore = readFileSync(sentinel, 'utf8');

  const baseline = exportBoard(source);
  assert.throws(() => store.recordRowDecisions(source, {
    agentId: 'web-1', channel: 'view', decisions: DECISIONS,
  }), { code: 'B26_PERSON_APPROVAL' });
  assert.throws(() => store.applyRowDecisions(source, { agentId: 'web-1', events: [] }), { code: 'COORDINATOR_ONLY' });
  assert.throws(() => store.recordRowDecisions(source, {
    agentId: 'person', channel: 'view', decisions: [{ ...DECISIONS[0], source: DECISIONS[0].source.replace('G1', 'G9') }],
  }), { code: 'ROW_DECISION' });
  assert.throws(() => store.recordRowDecisions(source, {
    agentId: 'person', channel: 'view', decisions: [{ ...DECISIONS[0], replacement: DECISIONS[0].source }],
  }), { code: 'ROW_DECISION' });
  assert.throws(() => store.recordRowDecisions(source, {
    agentId: 'person', channel: 'view', decisions: [{
      ...DECISIONS[1], text: 'Unrelated replacement text.',
      replacement: DECISIONS[1].replacement.replace('The person declined.', 'Unrelated replacement text.'),
    }],
  }), { code: 'ROW_DECISION' }, 'a decline cannot replace the source row with an unrelated phrase');
  const oldEngineExport = exportBoard(source);
  source.executionEngineVersion = 11;
  try {
    assert.throws(() => store.recordRowDecisions(source, {
      agentId: 'person', channel: 'view', decisions: [{
        ...DECISIONS[1], text: 'Decline this rule.',
        replacement: '- L1 [wont] Decline this rule.',
      }],
    }), { code: 'ROW_DECISION' }, 'engine 11 refuses the new preserved-text decline shape');
    assert.throws(() => store.recordRowDecisions(source, {
      agentId: 'person', channel: 'view', decisions: [{
        ...DECISIONS[1], replacement: 'not a row',
      }],
    }), { code: 'ROW_DECISION' }, 'engine 11 still refuses a malformed legacy replacement without throwing');
  } finally {
    delete source.executionEngineVersion;
  }
  assert.deepEqual(exportBoard(source), oldEngineExport, 'engine-version-specific refusals leave the board unchanged');
  assert.deepEqual(exportBoard(source), baseline, 'actor and source/replacement refusals leave tables and metadata unchanged');

  const recordMove = { ...prepareEngineMove(one, 'recordRowDecisions', [{
    agentId: 'person', channel: 'view', decisions: DECISIONS,
  }], { id: 'person-row-decisions' }), engine: 11 };
  const recorded = replayWithDifferentShells(one, two, recordMove, 1, RECORDED_AT);
  assert.equal(recorded.events.length, 2);
  assert.ok(recorded.events.every((event) => event.event_kind === 'row_decision' && event.event_by === 'person'));
  assert.ok(recorded.events.every((event) => event.event_at === RECORDED_AT));
  assert.deepEqual(JSON.parse(recorded.events[1].event_detail).record, DECISIONS[1], 'engine 11 retains the original decline receipt fields');
  assert.equal(store.rowDecisions(one)[1].text, DECISIONS[1].reason, 'engine 11 keeps its historical reason-as-text record');
  assert.deepEqual(store.rowDecisions(one).map(({ id, decision, applied }) => ({ id, decision, applied })), [
    { id: 'G1', decision: 'approve', applied: false },
    { id: 'L1', decision: 'decline', applied: false },
  ]);

  const eventIds = store.rowDecisions(one).map((record) => record.event);
  const applyMove = { ...prepareEngineMove(one, 'applyRowDecisions', [{ agentId: 'coordinator', events: eventIds }], { id: 'apply-row-decisions' }), engine: 11 };
  const applied = replayWithDifferentShells(one, two, applyMove, 2, APPLIED_AT);
  assert.equal(applied.events.length, 1);
  assert.equal(applied.events[0].event_kind, 'row_apply');
  assert.equal(applied.events[0].event_at, APPLIED_AT);
  assert.ok(store.rowDecisions(one).every((record) => record.applied && record.appliedAt === APPLIED_AT));
  assert.deepEqual(engineReceipt(one, 'person-row-decisions'), engineReceipt(two, 'person-row-decisions'));
  assert.deepEqual(engineReceipt(one, 'apply-row-decisions'), engineReceipt(two, 'apply-row-decisions'));
  assert.equal(appliedSequence(one), 2);
  assert.equal(appliedSequence(two), 2);
  assert.deepEqual(exportBoard(one), exportBoard(two), 'complete native exports include tables, metadata and receipts');
  const complete = exportBoard(one);
  assert.deepEqual(applyEngineMove(one, applyMove, { sequence: 2, at: APPLIED_AT }), applied);
  assert.deepEqual(exportBoard(one), complete, 'an acknowledged apply retry appends no duplicate events');
  assert.equal(readFileSync(sentinel, 'utf8'), sentinelBefore, 'board-only engine operations never rewrite SPEC.md');
});

test('engine 12 records preserved decline text and replays a separate reason [S18,S19,H16]', (t) => {
  assert.ok(ENGINE_VERSION >= 12, 'engine 12 decline semantics hold in every later engine');
  const { source, copies: [one, two] } = decisionCopies(t);
  const preserved = {
    kind: 'spec', file: 'SPEC.md', id: 'G2',
    source: '- G2 [draft] Preserve this declined row.',
    replacement: '- G2 [wont] Preserve this declined row.',
    text: 'Preserve this declined row.', decision: 'decline', reason: 'No longer needed.',
  };
  const legacy = {
    ...preserved,
    replacement: '- G2 [wont] No longer needed.',
    text: 'No longer needed.',
  };
  assert.throws(() => store.recordRowDecisions(source, {
    agentId: 'person', channel: 'view', decisions: [legacy],
  }), { code: 'ROW_DECISION' }, 'engine 12 refuses a new legacy-shaped decline');

  const move = { ...prepareEngineMove(one, 'recordRowDecisions', [{
    agentId: 'person', channel: 'view', decisions: [preserved],
  }], { id: 'engine-12-preserved-decline' }), engine: 12 };
  assert.equal(move.engine, 12);
  const first = applyEngineMove(one, move, { sequence: 1, at: RECORDED_AT });
  const second = applyEngineMove(two, move, { sequence: 1, at: RECORDED_AT });
  assert.deepEqual(first, second);
  assert.equal(first.error, undefined);
  assert.equal(JSON.parse(first.events[0].event_detail).record.text, preserved.text);
  assert.equal(JSON.parse(first.events[0].event_detail).record.reason, preserved.reason);
  assert.equal(store.rowDecisions(one)[0].replacement, preserved.replacement);
  assert.equal(store.rowDecisions(one)[0].text, preserved.text);
  assert.equal(store.rowDecisions(one)[0].reason, preserved.reason);
  assert.deepEqual(exportBoard(one), exportBoard(two));
});
