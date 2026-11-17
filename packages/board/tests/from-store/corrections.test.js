/** A corrected bar records why the old one was wrong, on the item and in stats [B10,B31,R1,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { applyEngineMove } from '../../../state/index.js';
import { applyRelayMove } from '../../../state/index.js';
import { prepareEngineMove } from '../../../state/index.js';
import { proofStats } from '../../../stats/index.js';
import { barCorrectionLine } from '../../../verify/index.js';
import { barCorrections } from '../../../verify/index.js';
import { barStatsLines } from '../../../verify/index.js';
import { counterProofStats } from '../../../verify/index.js';
import { cellBoard } from '../fixtures/cell-board.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../fixtures/cell-board.js';
import { closeCellBoard } from '../fixtures/cell-board.js';
import { submitFixture } from '../../../store/tests/fixtures/submit.js';

const HOUR = 3_600_000;

/** Freeze the criterion and check, with a digest of the frozen text, so a correction changes the digest as a real freeze does. */
const freeze = (item) => {
  const text = JSON.stringify({ criterion: item.item_criterion, check: item.item_check });
  return { text, digest: createHash('sha256').update(text).digest('hex') };
};

/** A real-Git project and a board with a coordinator, a web builder, a reviewer and three web items, no CLI. */
function fixture(t) {
  const project = cellProject(t, { real: true });
  mkdirSync(join(project.repo, 'web'), { recursive: true });
  writeFileSync(join(project.repo, 'web', 'shared.txt'), 'base\n');
  project.git(project.repo, 'add', '-A');
  project.git(project.repo, 'commit', '-q', '-m', 'chore: create bar fixture');
  const web = join(project.dir, 'web');
  project.git(project.repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  cellSeat(board, { lane: 'coordinator', path: project.repo });
  const builder = cellSeat(board, { lane: 'web', path: web }).id;
  const reviewer = cellSeat(board, { lane: 'web', path: join(project.dir, 'review') }).id;
  for (const title of ['Corrected item', 'Unclaimed item', 'Build-failed item']) {
    cellItem(board, { lane: 'web', title, specIds: ['G1'], criterion: `${title} works`, check: 'true' });
  }
  const claim = (id) => store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 2 * HOUR, freeze });
  /** The coordinator's edit, frozen the way the edit command freezes a corrected bar. */
  const edit = (id, change) => store.editItem(board, id, { agentId: 'coordinator', ...change, correction: true, freeze });
  /** Submit and reject only this control item, leaving the other bar fixtures genuinely unclaimed. */
  const rejectOnce = (id, note, clause) => {
    writeFileSync(join(web, 'web', 'shared.txt'), `implemented item ${id}\n`);
    project.git(web, 'add', 'web/shared.txt');
    project.git(web, 'commit', '-q', '-m', 'fix: implement bar fixture [G1]');
    const commit = project.git(web, 'rev-parse', 'HEAD');
    const policyCommit = project.git(project.repo, 'rev-parse', 'main');
    submitFixture(board, id, { agentId: builder, commit, tree: project.git(web, 'rev-parse', `${commit}^{tree}`), policyCommit, clausePolicyCommit: policyCommit, inspectClauses: true });
    store.verify(board, id, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', clause, note, head: commit, digest: store.getItem(board, id).item_frozen_digest, policy: 'any' });
  };
  /** The edit events of one item as the thread shows them. */
  const edits = (id) => store.itemThread(board, id).filter((entry) => entry.type === 'move' && entry.kind === 'edit');
  return { board, project, builder, reviewer, claim, edit, rejectOnce, edits };
}

test('board.corrections.corrected-bar-records-why-the-old: [B10,B31] a corrected bar records why the old one was wrong', (t) => {
  const box = fixture(t);
  const { board } = box;
  box.claim(1);

  assert.throws(() => box.edit(1, { criterion: 'Corrected item works under WAL' }), (error) => error.code === 'BAR_REASON' && /--reason/.test(error.message),
    'a criterion correction on a claimed item without a reason is refused, and the refusal names the flag');
  assert.equal(store.getItem(board, 1).item_criterion, 'Corrected item works', 'a refused correction changes nothing');

  box.edit(1, { criterion: 'Corrected item works under WAL', reason: 'the old bar described a lock a WAL board never takes' });
  const edit = box.edits(1).at(-1);
  assert.equal(edit.detail.reason, 'the old bar described a lock a WAL board never takes', 'the reason is stored with the edit');
  assert.deepEqual(edit.detail.barCorrection, { fields: ['criterion'], reject: null }, 'the edit is marked as a bar correction');

  const beforeRefreeze = store.getItem(board, 1);
  assert.throws(() => store.refreeze(board, 1, { agentId: box.builder, freeze }), { code: 'COORDINATOR_ONLY' }, 'only the coordinator refreezes a corrected bar');
  const afterRefusal = store.getItem(board, 1);
  assert.equal(afterRefusal.item_frozen_digest, beforeRefreeze.item_frozen_digest, 'the refused builder refreeze preserves the frozen bar');
  assert.equal(afterRefusal.item_owner, beforeRefreeze.item_owner, 'the refused builder refreeze preserves the owner');
  const refrozen = store.refreeze(board, 1, { agentId: 'coordinator', freeze });
  assert.equal(refrozen.retainedClaim, true, 'coordinator refreeze keeps the active claim');
  assert.equal(refrozen.unchanged, true, 'the coordinator edit already made the corrected frozen bar effective');
  const afterRefreeze = store.getItem(board, 1);
  assert.equal(afterRefreeze.item_status, 'claimed');
  assert.equal(afterRefreeze.item_owner, beforeRefreeze.item_owner);
  assert.equal(afterRefreeze.item_lease_until, beforeRefreeze.item_lease_until, 'refreeze keeps the existing lease');
  assert.equal(afterRefreeze.item_frozen_digest, beforeRefreeze.item_frozen_digest, 'an unchanged refreeze preserves the corrected bar digest');
  assert.equal(JSON.parse(afterRefreeze.item_frozen).criterion, 'Corrected item works under WAL');
  box.rejectOnce(1, 'the WAL lock never appears', 'Corrected item works under WAL');
  assert.throws(() => box.edit(1, { check: 'true # wal' }), { code: 'BAR_REASON' }, 'a check correction on an item that was claimed needs a reason too');
  box.edit(1, { check: 'true # wal', reason: 'the old check never opened a WAL board' });
  const marked = box.edits(1).at(-1);
  assert.equal(marked.detail.barCorrection.reject?.by, box.reviewer, 'a reject followed by a correction is marked as caused by the bar');
  assert.equal(marked.detail.barCorrection.reject?.reason, 'TEST_FAILURE');

  const [first, second] = barCorrections(store.itemThread(board, 1));
  assert.equal(barCorrectionLine(first), 'bar corrected by coordinator (criterion): the old bar described a lock a WAL board never takes', 'the first correction reads with its reason');
  assert.equal(barCorrectionLine(second), `bar corrected by coordinator (check): the old check never opened a WAL board; the reject by ${box.reviewer} was caused by the bar`,
    'the second reads with its reason and the reject it explains');

  box.edit(2, { criterion: 'Unclaimed item works better' });
  assert.equal(store.getItem(board, 2).item_criterion, 'Unclaimed item works better', 'an edit before any claim needs no reason');
  assert.equal(box.edits(2).at(-1).detail.barCorrection, undefined, 'an edit before any claim is not a bar correction');

  box.claim(3);
  box.rejectOnce(3, 'the build is broken', 'Build-failed item works');
  const stats = proofStats(board, {}, { events: store.events, counterProofStats }).bars;
  assert.deepEqual(stats, { coordinator: { corrections: 2, barRejects: 1, buildRejects: 1 } },
    'stats reports, per coordinator, bar corrections and rejects caused by a bar, beside rejects caused by the build');
  assert.deepEqual(barStatsLines(stats), ['bars: coordinator: 2 corrections, 1 reject caused by a bar, 1 reject caused by the build']);
});

test('board.corrections.the-bar-correction-rule-replays-engine: [B31,H16] the bar-correction rule replays by engine and takes nothing from the move but the reason', () => {
  let at = Date.parse('2026-10-17T00:00:00.000Z');
  const board = openCellBoard(':memory:', { now: () => new Date(at += 1000) });
  try {
    store.register(board, { lane: 'coordinator', path: '/repo' });
    store.register(board, { lane: 'web', path: '/repo-web-1' });
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Replayed', criterion: 'first' });
    store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze: (found) => ({ text: found.item_criterion, digest: 'd' }) });
    let sequence = 0;
    const receipt = () => ({ sequence: ++sequence, at: new Date(at).toISOString(), sender: { kind: 'agent', userId: 'user', agent: 'coordinator' }, kind: 'move' });

    const legacy = prepareEngineMove(board, 'editItem', [id, { agentId: 'coordinator', criterion: 'second' }]);
    legacy.engine = 12;
    assert.equal(applyRelayMove(board, legacy, receipt()).error, undefined, 'an engine-12 correction without a reason replays as it always did');
    assert.equal(store.getItem(board, id).item_criterion, 'second');

    const unexplained = prepareEngineMove(board, 'editItem', [id, { agentId: 'coordinator', criterion: 'third' }]);
    assert.equal(applyRelayMove(board, unexplained, receipt()).error?.code, 'BAR_REASON', 'a current correction without a reason is refused on every replica');

    const forged = prepareEngineMove(board, 'editItem', [id, { agentId: 'coordinator', criterion: 'third', reason: 'the second bar was wrong',
      barCorrection: { fields: [], reject: { by: 'web-9', reason: 'TEST_FAILURE' } } }]);
    assert.equal(applyRelayMove(board, forged, receipt()).error, undefined);
    const edit = store.events(board, { itemId: id }).filter((event) => event.event_kind === 'edit').map((event) => JSON.parse(event.event_detail)).at(-1);
    assert.deepEqual(edit.barCorrection, { fields: ['criterion'], reject: null }, 'the board derives the correction and its reject; a move cannot supply them');

    const old = prepareEngineMove(board, 'editItem', [id, { agentId: 'coordinator', criterion: 'fourth', reason: 'older engine' }]);
    old.engine = 12;
    const before = store.events(board).length;
    assert.throws(() => applyEngineMove(board, old, { sequence: sequence + 1, at: new Date(at).toISOString() }), { code: 'RELAY_MOVE' },
      'a reason-bearing edit sealed below the bar engine is refused before it is interpreted');
    assert.equal(store.events(board).length, before);

    const agent = applyRelayMove(board, prepareEngineMove(board, 'editItem', [id, { agentId: 'coordinator', criterion: 'fifth', reason: 'forged' }]),
      { ...receipt(), sender: { kind: 'agent', userId: 'user', agent: 'web-1' } });
    assert.equal(agent.error?.code, 'RELAY_SENDER_MISMATCH', 'an agent cannot correct a bar as the coordinator through the relay');
  } finally { closeCellBoard(board); }
});
