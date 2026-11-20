import { createItemSlice } from '../../../../index.js';
/** Native operation recipes extracted from study 7b08e883 for the complete reader oracle [H5,H16,A2].
 * Original recipes: whole ff/db757 material pool; integration/helper: whole420/475.
 * Synthetic receipts exercise projection only, never gate, CI, watch or provider-authority assurance.
 * Every covered operation must advance native events and pass the current complete reader oracle.
 */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import { join } from 'node:path';
import { cellItem } from '../../cell.js';
import { cellSeat } from '../../cell.js';

/** Count only actual native mutations whose full current owner-supplied oracle succeeds.
 * work may prepare genuine asynchronous gate evidence before its native mutation.
 * Coded refusals remain visible and uncovered; they never count as successful proof.
 */
export function createStudyExercise({ board, verifyAfterMutation, covered = new Set(), setupRefusals = [] }) {
  if (typeof verifyAfterMutation !== 'function') throw new TypeError('a complete current HTTP/pinned-API2 oracle is required');
  async function exercise(operation, work) {
    const before = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM event').get().n;
    let result;
    try { result = await work(); }
    catch (error) {
      if (!error.code) throw error;
      setupRefusals.push({ operation, code: error.code });
      return null;
    }
    const after = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM event').get().n;
    if (after === before) {
      setupRefusals.push({ operation, code: 'NO_MUTATION' });
      return result;
    }
    await verifyAfterMutation({ operation, before, after, result });
    covered.add(operation);
    return result;
  }
  return { exercise, covered, setupRefusals,
    missing: operations => operations.filter(operation => !covered.has(operation)) };
}

/** seedIdentity uses real operations; synthetic records retain their original explicit labels. */
export async function seedIdentity(context) {
  const { board, box, store, milestones, exercise, submitFixture, syntheticFlakeObservation, other, claim } = context;
  const agent = await exercise('register', () => store.register(board, { lane: box.lane, path: join(box.root, 'study-worker'), family: 'Fixture Parity Builder Vendor', parentDigest: 'a'.repeat(64) }));
  const reviewer = store.register(board, { lane: 'tests', path: join(box.root, 'study-reviewer'), family: 'Fixture Parity Reviewer Vendor', parentDigest: 'b'.repeat(64) });
  const item = await exercise('addItem', () => store.addItem(board, { by: 'coordinator', lane: box.lane,
    title: 'Lifecycle study', criterion: 'A seeded lifecycle.', brief: 'Seeded brief.' }));
  Object.assign(context, { agent, reviewer, item });
  return context;
}

/** seedOrdinaryWork uses real operations; synthetic records retain their original explicit labels. */
export async function seedOrdinaryWork(context) {
  const { board, box, store, milestones, exercise, submitFixture, syntheticFlakeObservation, agent, reviewer, item, other, claim } = context;
  await exercise('editItem', () => store.editItem(board, item, { agentId: 'coordinator', brief: 'Changed brief.', reason: 'study' }));
  await exercise('appendFact', () => store.appendFact(board, item, { agentId: 'coordinator', kind: 'measurement', text: 'Seeded fact.' }));
  const shout = await exercise('shout', () => store.shout(board, { from: agent, to: 'coordinator', text: 'Study question?', lanes: [box.lane], decision: true }));
  await exercise('passDecision', () => store.passDecision(board, shout, { agentId: 'coordinator', note: 'Study pass.', lanes: [box.lane] }));
  const answerable = store.shout(board, { from: agent, to: 'coordinator', text: 'Separate answerable question?', lanes: [box.lane], decision: true });
  await exercise('answerDecision', () => store.answerDecision(board, answerable, { agentId: 'coordinator', text: 'Study answer.', lanes: [box.lane] }));
  await exercise('holdItem', () => store.holdItem(board, item, { agentId: 'coordinator', reason: 'Study hold.' }));
  await exercise('releaseItemHold', () => store.releaseItemHold(board, item, { agentId: 'coordinator' }));
  await exercise('holdLane', () => store.holdLane(board, box.lane, { agentId: 'coordinator', reason: 'Study hold.' }));
  await exercise('releaseLane', () => store.releaseLane(board, box.lane, { agentId: 'coordinator' }));
  await exercise('declareJob', () => store.declareJob(board, { agentId: 'coordinator', name: 'study-job', every: '10m', owner: agent }));
  await exercise('recordJobRun', () => store.recordJobRun(board, { agentId: agent, name: 'study-job' }));
  await exercise('setLineSetting', () => store.setLineSetting(board, { agentId: 'coordinator', key: 'order', value: true, reason: 'Study projection.', window: { samples: 1 } }));
  await exercise('setBarReady', () => store.setBarReady(board, { agentId: 'coordinator', enabled: true }));
  await exercise('setBarReady', () => store.setBarReady(board, { agentId: 'coordinator', enabled: false }));
  return context;
}

/** seedMilestones uses real operations; synthetic records retain their original explicit labels. */
export async function seedMilestones(context) {
  const { board, box, store, milestones, exercise, submitFixture, syntheticFlakeObservation, agent, reviewer, item, claim } = context;
  const other = store.addItem(board, { by: 'coordinator', lane: box.lane, title: 'Second study item', criterion: 'Second seed.' });
  await exercise('addMilestone', () => milestones.addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'Study A', items: [item] }));
  await exercise('editMilestoneItems', () => milestones.editMilestoneItems(board, 'Study A', { agentId: 'coordinator', reason: 'Arrange fixture release', add: [other] }));
  await exercise('orderMilestoneItems', () => milestones.orderMilestoneItems(board, 'Study A', { agentId: 'coordinator', reason: 'Arrange fixture release', items: [other, item] }));
  await exercise('editMilestone', () => milestones.editMilestone(board, 'Study A', { agentId: 'coordinator', note: 'Changed roadmap note.', target: '2026-12-01' }));
  milestones.addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'Study B' });
  await exercise('moveMilestone', () => milestones.moveMilestone(board, 'Study B', { agentId: 'coordinator', before: 'Study A' }));
  await exercise('shipMilestone', () => milestones.shipMilestone(board, 'Study B', { agentId: 'coordinator', commit: 'a'.repeat(40) }));
  milestones.addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'Study removable' });
  await exercise('removeMilestone', () => milestones.removeMilestone(board, 'Study removable', { agentId: 'coordinator' }));
  Object.assign(context, { other });
  return context;
}

/** seedLifecycle uses real operations; synthetic records retain their original explicit labels. */
export async function seedLifecycle(context) {
  const { board, box, store, milestones, exercise, submitFixture, syntheticFlakeObservation, agent, reviewer, item, other } = context;
  const claim = { agentId: agent, lane: box.lane, leaseMs: 3600000,
    freeze: () => ({ text: '{"rows":[],"criterion":"A seeded lifecycle."}', digest: 'study-frozen' }) };
  await exercise('claim', () => store.claim(board, item, claim));
  const slice = await exercise('createItemSlice', () => createItemSlice(board, { agentId: agent,
    parentId: item, parentDigest: store.getItem(board, item).item_frozen_digest,
    title: 'Lifecycle projection slice', files: [`${box.lane}/projection-slice.js`] }));
  assert.equal(store.getItem(board, slice.item).item_parent_id, item, 'both readers observe a real slice of the frozen parent');
  await exercise('withdraw', () => store.withdraw(board, slice.item, { agentId: 'coordinator', reason: 'The parity slice observation is complete.' }));

  await exercise('recordAttempt', () => store.recordAttempt(board, item, { agentId: agent, n: 1, seconds: 1, result: 'red' }));
  await exercise('release', () => store.release(board, item, agent, 'Study release.', undefined, 'OTHER'));
  await exercise('refreeze', () => store.refreeze(board, item, { agentId: 'coordinator', freeze: claim.freeze }));
  store.claim(board, item, claim);
  await exercise('submit', () => submitFixture(board, item, { agentId: agent, commit: 'a'.repeat(40), tree: 'b'.repeat(40) }));
  await exercise('reopen', () => store.reopen(board, item, { agentId: 'coordinator', note: 'Study submitted-item return.' }));
  if (store.getItem(board, item).item_status === 'open') {
    store.claim(board, item, claim);
    submitFixture(board, item, { agentId: agent, commit: 'c'.repeat(40), tree: 'b'.repeat(40) });
  }
  await exercise('reserveReview', () => store.reserveReview(board, item, { agentId: reviewer, lane: 'tests', leaseMs: 3600000, policy: 'any' }));
  await exercise('reserveNextReview', () => store.reserveNextReview(board, { agentId: reviewer, lane: 'tests', leaseMs: 3600000, policy: 'any' }));
  await exercise('verify', () => store.verify(board, item, { agentId: reviewer, decision: 'ACCEPT', head: 'c'.repeat(40),
    digest: 'study-frozen', policy: 'any', note: 'Synthetic native state only; no gate execution claimed.' }));
  await exercise('merged', () => store.merged(board, item, { agentId: 'coordinator', commit: 'c'.repeat(40) }));
  await exercise('withdraw', () => store.withdraw(board, other, { agentId: 'coordinator', reason: 'Study withdrawal.' }));
  Object.assign(context, { claim });
  return context;
}

/** seedWatchReceipts uses real operations; synthetic records retain their original explicit labels. */
export async function seedWatchReceipts(context) {
  const { board, box, store, milestones, exercise, submitFixture, syntheticFlakeObservation, agent, reviewer, item, other, claim } = context;
  const watch = await exercise('proposeSentinel', () => board.enginePorts.store.proposeSentinel(board, { agentId: agent,
    row: { name: 'study-watch', check: 'true', every: 'hourly', owner: 'coordinator' } }));
  if (watch) {
    await exercise('decideSentinel', () => board.enginePorts.store.decideSentinel(board, { agentId: 'person', channel: 'terminal',
      name: watch.name, digest: watch.digest, decision: 'approve' }));
    await exercise('beginSentinelRun', () => board.enginePorts.store.beginSentinelRun(board, { agentId: agent, name: watch.name, digest: watch.digest, run: 'study-run' }));
    await exercise('finishSentinelRun', () => board.enginePorts.store.finishSentinelRun(board, { agentId: agent, name: watch.name, digest: watch.digest,
      run: 'study-run', result: { green: true, code: 0, timedOut: false, signal: null, aborted: false, durationMs: 1, output: 'Synthetic watch receipt, no command execution claimed.' } }));
  }
  return context;
}

/** seedObservationReceipts uses real operations; synthetic records retain their original explicit labels. */
export async function seedObservationReceipts(context) {
  const { board, box, store, milestones, exercise, submitFixture, syntheticFlakeObservation, agent, reviewer, item, other, claim } = context;
  await exercise('recordHealthFindings', () => store.recordHealthFindings(board, { agentId: 'coordinator',
    observedRevision: board.db.prepare('SELECT MAX(event_id) AS n FROM event').get().n,
    findings: [{ key: 'study-fixture', cause: 'STUDY_FIXTURE', subject: agent, title: 'Synthetic projection observation',
      since: board.clock.now().toISOString(), why: 'Private state fixture, not a real health finding', next: 'Read study metadata', item: null }] }));
  await exercise('recordFlakeObservation', () => board.enginePorts.store.recordFlakeObservation(board, { agentId: 'coordinator',
    lane: box.lane, observation: syntheticFlakeObservation('study-synthetic-unclassified') }));
  return context;
}

/** seedPublishFinding uses real operations; synthetic records retain their original explicit labels. */
export async function seedPublishFinding(context) {
  const { board, box, store, milestones, exercise, submitFixture, syntheticFlakeObservation, agent, reviewer, item, other, claim } = context;
  await exercise('recordPublishFinding', () => board.enginePorts.store.recordPublishFinding(board, { agentId: 'coordinator', item,
    repository: 'fixture/repository', pull: 1281, head: 'c'.repeat(40),
    failures: [{ id: 1281, name: 'Synthetic state only, not a CI failure', url: 'https://example.invalid/study', files: ['synthetic-study.txt'] }] }));
  return context;
}

/** seedBaselineReceipts uses real operations; synthetic records retain their original explicit labels. */
export async function seedBaselineReceipts(context) {
  const { board, box, store, milestones, exercise, submitFixture, syntheticFlakeObservation, agent, reviewer, item, other, claim } = context;
  const command = 'node -e "process.exit(0)"';
  const pending = { command, main: 'a'.repeat(40), request: randomUUID(), result: 'pending' };
  const baselineItem = store.addItem(board, { by: 'coordinator', lane: box.lane, title: 'Unavailable baseline state',
    criterion: 'State projection only.', check: command, checkBaseline: pending });
  await exercise('completeCheckBaseline', () => store.completeCheckBaseline(board, baselineItem, { agentId: 'coordinator', expected: pending,
    baseline: { ...pending, result: 'unavailable', reason: 'Synthetic native-state fixture; no baseline execution claimed.' } }));
  await exercise('acceptCheck', () => store.acceptCheck(board, baselineItem, { agentId: 'person', channel: 'terminal',
    digest: createHash('sha256').update(command).digest('hex') }));
  return context;
}

/** seedActivityReceipts uses real operations; synthetic records retain their original explicit labels. */
export async function seedActivityReceipts(context) {
  const { board, box, store, milestones, exercise, submitFixture, syntheticFlakeObservation, agent, reviewer, item, other, claim } = context;
  const idleSeat = store.register(board, { lane: box.lane, path: join(box.root, 'idle-observer') });
  await exercise('recordNextIdle', () => store.recordNextIdle(board, { agentId: idleSeat, reason: 'nothing-eligible' }));
  const answered = board.db.prepare("SELECT MAX(event_id) AS n FROM event WHERE event_kind='answer'").get().n;
  const through = board.db.prepare('SELECT MAX(event_id) AS n FROM event').get().n;
  await exercise('recordActivityDelivery', () => store.recordActivityDelivery(board, { agentId: agent, through, digestThrough: through,
    interrupts: answered ? [{ id: 'event:' + answered, eventId: answered, reason: 'answered' }] : [] }));
  if (answered) await exercise('actOnActivity', () => store.actOnActivity(board, { agentId: agent, ids: ['event:' + answered] }));
  return context;
}

/** seedSpecAndHandoff uses real operations; synthetic records retain their original explicit labels. */
export async function seedSpecAndHandoff(context) {
  const { board, box, store, milestones, exercise, submitFixture, syntheticFlakeObservation, agent, reviewer, item, other, claim } = context;
  await exercise('draftSpecRow', () => store.draftSpecRow(board, { agentId: agent,
    row: { id: 'Z1281', text: 'Study row.', gate: 'review', tier: 'must', section: 'Study', target: 'spec' } }));
  const row = { kind: 'spec', id: 'Z1281', file: 'SPEC.md', source: '- Z1281 [draft, must] Study row. | gate: review',
    replacement: '- Z1281 [approved, must] Study row. | gate: review', text: 'Study row.', decision: 'approve' };
  const decisions = await exercise('recordRowDecisions', () => store.recordRowDecisions(board, { agentId: 'person', channel: 'terminal', decisions: [row] }));
  if (decisions) await exercise('applyRowDecisions', () => store.applyRowDecisions(board, {
    agentId: 'coordinator', events: decisions.map(value => value.event), refreezes: [],
  }));
  return context;
}

/** Cover rehome operations with real source records and an auxiliary in-memory board. */
export async function seedRehome(context) {
  const { board, box, store, exercise, agent } = context;
  const auxiliary = store.openBoard(':memory:');
  try {
    store.ensureCoordinator(auxiliary, join(box.root, '.parity-rehome-auxiliary'));
    const sourceBoardId = store.boardId(auxiliary);
    const destinationBoardId = store.boardId(board);
    const incomingMoveId = 'parity-rehome-incoming';
    const incomingItem = store.addItem(auxiliary, { by: 'coordinator', lane: box.lane,
      title: 'Parity incoming item', criterion: 'A real open source item.' });
    const incomingDestinationId = await exercise('reserveRehomeItemId', () =>
      store.reserveRehomeItemId(board, sourceBoardId, incomingMoveId, { agentId: 'coordinator' }));
    const incomingRecord = store.rehomeItem(auxiliary, incomingItem, { agentId: 'coordinator',
      sourceMoveId: incomingMoveId, destinationBoardId, destinationItemId: incomingDestinationId });
    await exercise('applyRehomeItem', () => store.applyRehomeItem(board, incomingRecord,
      { destinationAgentId: 'coordinator' }));

    const outgoingItem = await exercise('addItem', () => store.addItem(board, { by: 'coordinator', lane: box.lane,
      title: 'Parity outgoing item', criterion: 'A real open source item.' }));
    const outgoingMoveId = 'parity-rehome-outgoing';
    const outgoingDestinationId = store.reserveRehomeItemId(auxiliary, destinationBoardId,
      outgoingMoveId, { agentId: 'coordinator' });
    await exercise('rehomeItem', () => store.rehomeItem(board, outgoingItem, { agentId: agent,
      sourceMoveId: outgoingMoveId, destinationBoardId: sourceBoardId, destinationItemId: outgoingDestinationId }));
  } finally {
    store.closeBoard(auxiliary);
  }
  return context;
}

/** Retire the outgoing native seat only after its remaining projection recipes have completed. */
export async function seedHandoff(context) {
  const { board, store, exercise, agent, reviewer } = context;
  const handoff = await exercise('openHandoff', () => store.openHandoff(board, { agentId: agent }));
  if (handoff) await exercise('takeHandoff', () => store.takeHandoff(board, { agentId: reviewer, item: handoff.item }));
  return context;
}

/** seedBlocks files a block of two items, claims it for a strong seat, then reserves and clears one open item, all through the native moves. */
export async function seedBlocks(context) {
  const { board, box, store, exercise } = context;
  const file = title => cellItem(board, { lane: box.lane, title, route: 'mid', check: 'true',
    criterion: 'The parity block fixture records its move.',
    brief: 'Files:\n- web/page.js\nChange:\n- copy the header from the api\nTest:\n- the page test asserts the header\nOut of scope: anything else\n' }).item_id;
  const ids = [file('Parity block first'), file('Parity block second')];
  await exercise('addBlock', () => store.addBlock(board, { agentId: 'coordinator', name: 'parity-pair', ids, tier: 'mid' }));
  const seat = cellSeat(board, { lane: box.lane, path: join(box.root, 'study-block-seat'), route: 'strong', family: 'Fixture Parity Block Vendor' }).id;
  await exercise('claimBlock', () => store.claimBlock(board, { agentId: seat, name: 'parity-pair', lane: box.lane, leaseMs: 3600000,
    freeze: row => ({ text: row.item_title, digest: `parity-block:${row.item_title}` }) }));
  const reserved = file('Parity reserved item');
  await exercise('reserveItem', () => store.reserveItem(board, reserved, { agentId: 'coordinator', holder: 'parity-seat' }));
  await exercise('clearReservation', () => store.clearReservation(board, reserved, { agentId: 'coordinator' }));
  return context;
}

/** Optional original ordering. Owners may instead call individual phases with valid prerequisites. */
export async function seedStudyState(context) {
  await seedIdentity(context);
  await seedOrdinaryWork(context);
  await seedMilestones(context);
  await seedLifecycle(context);
  await seedWatchReceipts(context);
  await seedObservationReceipts(context);
  await seedPublishFinding(context);
  await seedBaselineReceipts(context);
  await seedActivityReceipts(context);
  await seedSpecAndHandoff(context);
  return context;
}
