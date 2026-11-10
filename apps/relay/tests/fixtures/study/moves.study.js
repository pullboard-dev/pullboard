import { viewApiPorts } from '../../../../view/index.js';
import { apiBoardOpeners } from '../../../../cli/tests/fixtures/board.js';
import {
  nativeBoardPorts as relayPresentationNativePorts,
  openBoard,
  draftSpecRow,
} from '../../../../lib/index.js';
import { proposeSentinel as nativeProposeSentinel } from '../../../../../packages/sentinels/index.js';
import { decideSentinel as nativeDecideSentinel } from '../../../../../packages/sentinels/index.js';
import { beginSentinelRun as nativeBeginSentinelRun } from '../../../../../packages/sentinels/index.js';
import { finishSentinelRun as nativeFinishSentinelRun } from '../../../../../packages/sentinels/index.js';
import { recordFlakeObservation as nativeRecordFlakeObservation } from '../../../../../packages/flakes/index.js';
import { recordPublishFinding as nativeRecordPublishFinding } from '../../../../../packages/github/index.js';
/** Exercise native move effects before comparing the actual relay's complete decoded projection [H5,H17]. */
import assert from 'node:assert/strict';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import {
  addMilestone,
  editMilestoneItems,
  orderMilestoneItems,
  editMilestone,
  moveMilestone,
  shipMilestone,
  removeMilestone,
} from '../../../../../packages/store/index.js';
import * as milestones from '../../../../../packages/store/index.js';
import { MOVE_OPERATIONS } from '../../../../../packages/moves/index.js';
import { relaySnapshot } from '../../../../../packages/pages/index.js';
import { relayClientFixture } from '../../../../cli/tests/fixtures/relay/client.js';
import {
  differences,
  paths,
  readRelay,
  valueDifferences,
} from '../../../../../packages/pages/tests/fixtures/study.js';
import { serveApi } from '../../../../../packages/api/index.js';
import { refusalDocument } from '../../../../cli/index.js';
import { main } from '../../../../cli/tests/fixtures/native.js';
import { presentationState } from '../../../index.js';
import { apiFetch } from '../../../../cli/tests/fixtures/api.js';
import { submitFixture } from '../../../../cli/tests/fixtures/board/submit.js';
import { syntheticFlakeObservation } from '../../../../cli/tests/fixtures/observation.js';

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

test('relay study compares each exercised move effect through the real API2 reader [H5,H17]', { timeout: 180_000 }, async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const covered = new Set(), setupRefusals = [], nativeParity = [];
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, projects: () => [{ root: box.root, name: 'study', project: '', added: '2026-10-26T00:00:00.000Z' }], stateDetail: 'full' });
  t.after(() => api.close());
  const address = new URL(api.url);
  const nativeApi = { origin: address.origin, secret: address.searchParams.get('k') };
  const boardId = (await (await apiFetch(nativeApi, '/api/v1/boards')).json()).boards[0].id;
  /** Diff the native view's state against what a relay reader renders from the decrypted presentation. */
  async function compareNative(operation, presentation) {
    const native = (await (await apiFetch(nativeApi, '/api/v1/boards/' + boardId + '/state')).json()).state;
    const reader = presentationState(presentation, boardId);
    const nativePaths = paths(native), readerPaths = paths(reader);
    nativeParity.push({ operation, onlyNative: [...nativePaths].filter(path => !readerPaths.has(path)).sort(),
      onlyReader: [...readerPaths].filter(path => !nativePaths.has(path)).sort(), differingValues: valueDifferences(native, reader) });
  }
  t.after(() => {
    const union = field => [...new Set(nativeParity.flatMap(entry => entry[field]))].sort();
    t.diagnostic(JSON.stringify({ phase: 'native-versus-reader-per-move', node: process.versions.node, operations: nativeParity.length,
      onlyNative: union('onlyNative'), onlyReader: union('onlyReader'), differingValues: union('differingValues'),
      perOperation: nativeParity.map(entry => ({ operation: entry.operation, onlyNative: entry.onlyNative.length,
        onlyReader: entry.onlyReader, differingValues: entry.differingValues })),
      scope: 'After each exercised move: GET /api/v1/boards/:id/state (stateDetail full) against presentationState of the decrypted relay presentation; as-of clock readings ignored.' }));
  });
  t.after(() => t.diagnostic(JSON.stringify({ phase: 'move-effect-parity', node: process.versions.node,
    coveredMoves: [...covered], setupRefusals, uncoveredMoves: MOVE_OPERATIONS.filter(operation => !covered.has(operation)),
    limitation: 'Native board-state fixtures with actual API2 transport; synthetic submit is explicitly not a gate proof. Only successful event-producing calls counted.' })));
  /** Only successful native calls count as covered; a refused setup never supplies parity evidence. */
  async function exercise(operation, work) {
    const before = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM event').get().n;
    let result;
    try { result = work(); }
    catch (error) {
      if (!error.code) throw error;
      setupRefusals.push({ operation, code: error.code });
      return null;
    }
    if (board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM event').get().n === before) {
      setupRefusals.push({ operation, code: 'NO_MUTATION' });
      return result;
    }
    const published = await box.cli('status');
    assert.equal(published.code, 0, 'the actual CLI publishes after ' + operation);
    const expected = relaySnapshot(box.root, {}, RELAY_PRESENTATION_PORTS);
    const read = await readRelay(box);
    assert.deepEqual(differences(expected.presentation, read.document.presentation), [], operation + ' full presentation');
    assert.deepEqual(differences(expected.tables, read.document.tables), [], operation + ' native tables');
    await compareNative(operation, read.document.presentation);
    covered.add(operation);
    return result;
  }
  const agent = await exercise('register', () => store.register(board, { lane: box.lane, path: join(box.root, 'study-worker'), parentDigest: 'a'.repeat(64) }));
  const reviewer = store.register(board, { lane: 'tests', path: join(box.root, 'study-reviewer'), parentDigest: 'b'.repeat(64) });
  const item = await exercise('addItem', () => store.addItem(board, { by: 'coordinator', lane: box.lane,
    title: 'Lifecycle study', criterion: 'A seeded lifecycle.', brief: 'Seeded brief.' }));
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
  await exercise('addMilestone', () => addMilestone(board, { agentId: 'coordinator', name: 'Study A', items: [item] }));
  const other = store.addItem(board, { by: 'coordinator', lane: box.lane, title: 'Second study item', criterion: 'Second seed.' });
  await exercise('editMilestoneItems', () => editMilestoneItems(board, 'Study A', { agentId: 'coordinator', add: [other] }));
  await exercise('orderMilestoneItems', () => orderMilestoneItems(board, 'Study A', { agentId: 'coordinator', items: [other, item] }));
  await exercise('editMilestone', () => editMilestone(board, 'Study A', { agentId: 'coordinator', note: 'Changed roadmap note.', target: '2026-12-01' }));
  addMilestone(board, { agentId: 'coordinator', name: 'Study B' });
  await exercise('moveMilestone', () => moveMilestone(board, 'Study B', { agentId: 'coordinator', before: 'Study A' }));
  await exercise('shipMilestone', () => shipMilestone(board, 'Study B', { agentId: 'coordinator', commit: 'a'.repeat(40) }));
  addMilestone(board, { agentId: 'coordinator', name: 'Study removable' });
  await exercise('removeMilestone', () => removeMilestone(board, 'Study removable', { agentId: 'coordinator' }));
  const claim = { agentId: agent, lane: box.lane, leaseMs: 3600000,
    freeze: () => ({ text: '{"rows":[]}', digest: 'study-frozen' }) };
  await exercise('claim', () => store.claim(board, item, claim));
  await exercise('recordAttempt', () => store.recordAttempt(board, item, { agentId: agent, n: 1, seconds: 1, result: 'red' }));
  await exercise('release', () => store.release(board, item, agent, 'Study release.', 'OTHER'));
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
  const watch = await exercise('proposeSentinel', () => nativeProposeSentinel(board, { agentId: agent,
    row: { name: 'study-watch', check: 'true', every: 'hourly', owner: 'coordinator' } }));
  if (watch) {
    await exercise('decideSentinel', () => nativeDecideSentinel(board, { agentId: 'person', channel: 'terminal',
      name: watch.name, digest: watch.digest, decision: 'approve' }));
    await exercise('beginSentinelRun', () => nativeBeginSentinelRun(board, { agentId: agent, name: watch.name, digest: watch.digest, run: 'study-run' }));
    await exercise('finishSentinelRun', () => nativeFinishSentinelRun(board, { agentId: agent, name: watch.name, digest: watch.digest,
      run: 'study-run', result: { green: true, code: 0, timedOut: false, signal: null, aborted: false, durationMs: 1, output: 'Synthetic watch receipt, no command execution claimed.' } }));
  }
  await exercise('recordHealthFindings', () => store.recordHealthFindings(board, { agentId: 'coordinator',
    observedRevision: board.db.prepare('SELECT MAX(event_id) AS n FROM event').get().n,
    findings: [{ key: 'study-fixture', cause: 'STUDY_FIXTURE', subject: agent, title: 'Synthetic projection observation',
      since: board.clock.now().toISOString(), why: 'Private state fixture, not a real health finding', next: 'Read study metadata', item: null }] }));
  await exercise('recordFlakeObservation', () => nativeRecordFlakeObservation(board, { agentId: 'coordinator',
    lane: box.lane, observation: syntheticFlakeObservation('study-synthetic-unclassified') }));
  const outsideText = '{"rows":[]}';
  const outside = await exercise('intakeOutside', () => store.intakeOutside(board, { agentId: 'coordinator',
    source: { kind: 'pull-request', repository: 'fixture/repository', number: 1281, author: 'study-contributor',
      state: 'open', maintainerReplied: false, commit: 'd'.repeat(40), tree: 'e'.repeat(40), base: 'f'.repeat(40),
      files: ['synthetic-study.txt'], sensitive: true },
    item: { lane: box.lane, title: 'Synthetic outside state', criterion: 'State projection only.', route: 'strong' },
    frozen: { text: outsideText, digest: createHash('sha256').update(outsideText).digest('hex') } }));
  if (outside) await exercise('approveOutside', () => store.approveOutside(board, outside, { agentId: 'person' }));
  await exercise('recordPublishFinding', () => nativeRecordPublishFinding(board, { agentId: 'coordinator', item,
    repository: 'fixture/repository', pull: 1281, head: 'c'.repeat(40),
    failures: [{ id: 1281, name: 'Synthetic state only, not a CI failure', url: 'https://example.invalid/study', files: ['synthetic-study.txt'] }] }));
  const command = 'node -e "process.exit(0)"';
  const pending = { command, main: 'a'.repeat(40), request: randomUUID(), result: 'pending' };
  const baselineItem = store.addItem(board, { by: 'coordinator', lane: box.lane, title: 'Unavailable baseline state',
    criterion: 'State projection only.', check: command, checkBaseline: pending });
  await exercise('completeCheckBaseline', () => store.completeCheckBaseline(board, baselineItem, { agentId: 'coordinator', expected: pending,
    baseline: { ...pending, result: 'unavailable', reason: 'Synthetic native-state fixture; no baseline execution claimed.' } }));
  await exercise('acceptCheck', () => store.acceptCheck(board, baselineItem, { agentId: 'person', channel: 'terminal',
    digest: createHash('sha256').update(command).digest('hex') }));
  const answered = board.db.prepare("SELECT MAX(event_id) AS n FROM event WHERE event_kind='answer'").get().n;
  const through = board.db.prepare('SELECT MAX(event_id) AS n FROM event').get().n;
  await exercise('recordActivityDelivery', () => store.recordActivityDelivery(board, { agentId: agent, through, digestThrough: through,
    interrupts: answered ? [{ id: 'event:' + answered, eventId: answered, reason: 'answered' }] : [] }));
  if (answered) await exercise('actOnActivity', () => store.actOnActivity(board, { agentId: agent, ids: ['event:' + answered] }));
  await exercise('draftSpecRow', () => draftSpecRow(board, { agentId: agent,
    row: { id: 'Z1281', text: 'Study row.', gate: 'review', tier: 'must', section: 'Study', target: 'spec' } }));
  const row = { kind: 'spec', id: 'Z1281', file: 'SPEC.md', source: '- Z1281 [draft, must] Study row. | gate: review',
    replacement: '- Z1281 [approved, must] Study row. | gate: review', text: 'Study row.', decision: 'approve' };
  const decisions = await exercise('recordRowDecisions', () => store.recordRowDecisions(board, { agentId: 'person', channel: 'terminal', decisions: [row] }));
  if (decisions) await exercise('applyRowDecisions', () => store.applyRowDecisions(board, { agentId: 'coordinator', events: decisions.map(value => value.event) }));
  const handoff = await exercise('openHandoff', () => store.openHandoff(board, { agentId: agent }));
  if (handoff) await exercise('takeHandoff', () => store.takeHandoff(board, { agentId: reviewer, item: handoff.item }));
});
