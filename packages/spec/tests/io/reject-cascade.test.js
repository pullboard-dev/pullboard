/** @pullboard-test-input source-cell spec */
/** Rejecting a spec row writes a needs-review event for each row that serves it, only with spec.cascadeReject on [C7,#9341]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';
import { atomic } from '../../../store/index.js';
import { logEvent } from '../../../store/index.js';
import { writeBoardMeta } from '../../../store/index.js';
import { parseSpec } from '../../index.js';
import { recordRowVerification } from '../../index.js';

const clock = { now: () => new Date() };
const SOURCE = '- F2 [approved, must] Fact two holds. | gate: review';
const SPEC_ROWS = [
  { id: 'F2', serves: [] },
  { id: 'I1', serves: ['F2'] },
  { id: 'I3', serves: ['I1'] },
  { id: 'X9', serves: [] },
];

/** Run `work` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, work) {
  const { root } = privateFixtureFiles('pullboard-reject-cascade-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return work();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** Record a rejection of F2 by an outside-parent verifier on a fresh board and return the events it wrote after the verification. */
function reject(t, cascade) {
  const board = cellBoard(t, ':memory:', clock);
  writeBoardMeta(board.db, 'agent_parent_session:author', 'session-a');
  writeBoardMeta(board.db, 'agent_parent_session:verifier', 'session-b');
  const row = parseSpec(`## Verification\n${SOURCE}\n`).rows[0];
  const rowDrafts = () => [{ id: 'F2', by: 'author', target: 'spec', text: row.text, gate: row.gate, tier: row.tier }];
  const receipt = recordRowVerification(board, { agentId: 'verifier', source: SOURCE, decision: 'rejected', reason: 'wording is wrong', cascade },
    { atomic, logEvent, rowDrafts, rowDecisions: () => [] });
  const events = board.db.prepare('SELECT event_kind, event_detail FROM event WHERE event_id >= ? ORDER BY event_id').all(receipt.event)
    .map(event => ({ kind: event.event_kind, detail: JSON.parse(event.event_detail) }));
  return events;
}

test('clause 1: with spec.cascadeReject on, rejecting F2 writes one needs-review event each for I1 and I3 naming F2 [C7,#9341]', (t) => withSettings({ spec: { cascadeReject: true } }, () => {
  const events = reject(t, SPEC_ROWS);
  const marks = events.filter(event => event.kind === 'row_needs_review');
  assert.deepEqual(marks.map(event => event.detail.id), ['I1', 'I3']);
  assert.ok(marks.every(event => event.detail.because === 'F2'), 'each mark names the rejected row');
  assert.deepEqual(events.map(event => event.kind), ['row_verification', 'row_needs_review', 'row_needs_review']);
}));

test('clause 2: with spec.cascadeReject off a rejection writes exactly the one verification event it wrote before [C7,#9341]', (t) => withSettings({}, () => {
  assert.deepEqual(reject(t, SPEC_ROWS).map(event => event.kind), ['row_verification']);
}));
