/** @pullboard-test-input docs/formats.md */
/** The live-behavior case of the format guide: its schema, versions, event kinds and event detail fields match what the code does, in its own file so each file fits the per-file budget [A5,A10]. */
import { recordRelayExclusionIntent } from '../../../../packages/link/index.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { submitFixture } from '../../../../apps/cli/tests/fixtures/board/submit.js';
import { exerciseRejectedWorkFormat } from '../../../../apps/lib/tests/fixtures/rejected.js';
import { AUTO_SUBMIT_QUARANTINE_ENGINE } from '../../../../packages/state/light.js';
import { syntheticFlakeObservation } from '../../../../apps/cli/tests/fixtures/observation.js';
import { reviewDefaultEventContract } from '../../../../apps/lib/tests/fixtures/generated/doc/default.js';
import { pipelineEventContract } from '../../../../apps/lib/tests/fixtures/generated/doc/pipeline.js';
import { sourceAdvanceEventContract } from '../../../../packages/runners/tests/fixtures/advance.js';
import { recordFlakeObservation } from '../../../../apps/lib/index.js';
import { openBoard } from '../../../../apps/lib/index.js';
import { draftSpecRow } from '../../../../apps/lib/index.js';
import { board_recordNextIdle as recordNextIdle } from '../../../../packages/store/index.js';
import { addMilestone } from '../../../../packages/store/index.js';
import { editMilestoneItems } from '../../../../packages/store/index.js';
import { logEvent } from '../../../../packages/store/index.js';
import { proposeSentinel } from '../../../../packages/sentinels/index.js';
import { decideSentinel } from '../../../../packages/sentinels/index.js';
import { beginSentinelRun } from '../../../../packages/sentinels/index.js';
import { finishSentinelRun } from '../../../../packages/sentinels/index.js';
import { COORDINATOR } from '../../../../packages/config/index.js';
import { JSON_SHAPES } from '../../../../packages/config/index.js';
import { appliedSequence } from '../../../../packages/state/index.js';
import { applyEngineMove } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { ACCEPT_REASON } from '../../../../packages/store/index.js';
import { actOnActivity } from '../../../../packages/store/index.js';
import { recordActivityDelivery } from '../../../../packages/store/index.js';
import { answerDecision } from '../../../../packages/store/index.js';
import { addItem } from '../../../../packages/store/index.js';
import { requestCompanion } from '../../../../packages/store/index.js';
import { appendFact } from '../../../../packages/store/index.js';
import { claim } from '../../../../packages/store/index.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { editItem } from '../../../../packages/store/index.js';
import { EVENT_LOG_VERSION } from '../../../../packages/store/index.js';
import { board_ensureCoordinator as ensureCoordinator } from '../../../../packages/store/index.js';
import { escalate } from '../../../../packages/store/index.js';
import { events } from '../../../../packages/store/index.js';
import { holdLane } from '../../../../packages/store/index.js';
import { holdItem } from '../../../../packages/store/index.js';
import { merged } from '../../../../packages/store/index.js';
import { recordLandingBatch } from '../../../../packages/store/index.js';
import { recordLandingWaiver } from '../../../../packages/store/index.js';
import { recordLandingFlake } from '../../../../packages/store/index.js';
import { recordHealthFindings } from '../../../../packages/store/index.js';
import { boardId } from '../../../../packages/store/index.js';
import { setBoardMembers } from '../../../../packages/store/index.js';
import { passDecision } from '../../../../packages/store/index.js';
import { PERSON } from '../../../../packages/store/index.js';
import { recordAttempt } from '../../../../packages/store/index.js';
import { recordUsage } from '../../../../packages/store/index.js';
import { recordSharedUsage } from '../../../../packages/store/index.js';
import { recordRowDecisions } from '../../../../packages/store/index.js';
import { applyRowDecisions } from '../../../../packages/store/index.js';
import { refreeze } from '../../../../packages/store/index.js';
import { register } from '../../../../packages/store/index.js';
import { release } from '../../../../packages/store/index.js';
import { releaseLane } from '../../../../packages/store/index.js';
import { releaseItemHold } from '../../../../packages/store/index.js';
import { reopen } from '../../../../packages/store/index.js';
import { reserveReview } from '../../../../packages/store/index.js';
import { SCHEMA_VERSION } from '../../../../packages/store/index.js';
import { setLaneLead } from '../../../../packages/store/index.js';
import { shout } from '../../../../packages/store/index.js';
import { verify } from '../../../../packages/store/index.js';
import { withdraw } from '../../../../packages/store/index.js';
import { SPEC_GRAMMAR_VERSION } from '../../../../packages/spec/index.js';
import { sha256 } from '../../../../packages/spec/index.js';
import { recordSigningEvents } from '../../../../apps/cli/tests/fixtures/person/passkey.js';
import { block } from '../../../lib/tests/fixtures/formats-guide.js';
import { documentedEvents } from '../../../lib/tests/fixtures/formats-guide.js';

/** Parse table, column, type and rules from the documented live schema. */
function documentedColumns(start, end) {
  const result = {};
  for (const line of block(start, end).split(/\r?\n/)) {
    const row = /^\| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \| (.+) \|$/.exec(line);
    if (!row) continue;
    const [, table, column, type, cell] = row;
    const fields = result[table] ?? [];
    fields.push({ column, type, rules: [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]) });
    result[table] = fields;
  }
  return result;
}

/** Describe live columns from SQLite's null, default, key and reference metadata. */
function liveColumns(db, schema) {
  const tables = db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  return Object.fromEntries(tables.map(({ name }) => {
    const columns = db.prepare(`PRAGMA ${schema}.table_info(${name})`).all();
    const foreignKeys = db.prepare(`PRAGMA ${schema}.foreign_key_list(${name})`).all();
    const indexes = db.prepare(`PRAGMA ${schema}.index_list(${name})`).all();
    const uniqueColumns = indexes.filter((index) => index.unique && index.origin !== 'pk')
      .flatMap((index) => db.prepare(`PRAGMA ${schema}.index_info(${index.name})`).all())
      .map((column) => column.name);
    return [name, columns.map((column) => {
      const rules = [];
      if (column.pk) rules.push('PRIMARY KEY');
      else rules.push(column.notnull ? 'NOT NULL' : 'nullable');
      if (column.dflt_value !== null) rules.push(`DEFAULT ${column.dflt_value}`);
      if (uniqueColumns.includes(column.name)) rules.push('UNIQUE');
      for (const foreignKey of foreignKeys.filter((key) => key.from === column.name)) {
        rules.push(`REFERENCES ${foreignKey.table}(${foreignKey.to})`);
      }
      return { column: column.name, type: column.type, rules };
    })];
  }));
}

/** Read persistent and connection-local trigger declarations from SQLite. */
function liveTriggers(db, schema) {
  return db.prepare(`SELECT name, tbl_name FROM ${schema}.sqlite_master WHERE type = 'trigger' ORDER BY name`)
    .all().map(({ name, tbl_name }) => [name, tbl_name]);
}

/** Parse documented persistent or temporary trigger names and target tables. */
function documentedTriggers(start, end) {
  return block(start, end).split(/\r?\n/).flatMap((line) => {
    const row = /^\| `([^`]+)` \| `([^`]+)` \|$/.exec(line);
    return row ? [[row[1], row[2]]] : [];
  });
}

/** Read named indexes and their fields from the live database. */
function liveIndexes(db) {
  const indexes = db.prepare("SELECT name, tbl_name FROM main.sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return indexes.map(({ name, tbl_name }) => ({
    name,
    table: tbl_name,
    columns: db.prepare(`PRAGMA main.index_info(${name})`).all().map((column) => column.name),
    unique: db.prepare(`PRAGMA main.index_list(${tbl_name})`).all().find((index) => index.name === name).unique ? 'yes' : 'no',
  }));
}

/** Parse documented columns for an index. */
function documentedIndexes() {
  return block('<!-- board-indexes:start -->', '<!-- board-indexes:end -->').split(/\r?\n/).flatMap((line) => {
    const row = /^\| `([^`]+)` \| `([^`]+)` \| (.+) \| (yes|no) \|$/.exec(line);
    return row ? [{ name: row[1], table: row[2], columns: [...row[3].matchAll(/`([^`]+)`/g)].map((match) => match[1] === '(expression)' ? null : match[1]), unique: row[4] }] : [];
  });
}

/** List the documented in-place upgrade conditions exercised by exerciseUpgrade. */
function documentedUpgradeConditions() {
  return block('<!-- upgrade-rules:start -->', '<!-- upgrade-rules:end -->').split(/\r?\n/).flatMap((line) => {
    const row = /^\| (.+) \| (.+) \|$/.exec(line);
    return row && row[1] !== 'Older board condition' && row[1] !== '---' ? [[row[1], row[2]]] : [];
  });
}

/** Exercise each board event through the public API and return the rows it actually records. */
function recordEventContract() {
  const board = openBoard(':memory:');
  const coordinator = ensureCoordinator(board, '/coordinator');
  // Synthetic format fixture; cryptographic authority is exercised by relay-membership.test.js.
  setBoardMembers(board, { agentId: coordinator, document: { body: { v: 1, board: boardId(board), repository: 'fixture/repository', revision: 1, members: ['bob'] }, by: 'alice', signature: '-----BEGIN SSH SIGNATURE-----\nsynthetic format fixture\n' } });
  // A strict builder must declare its vendor family when it joins, so the family event comes from a seat that joins without one and later names it (a join that names a family records it, #4086).
  const builder = register(board, { lane: 'docs', path: '/builder', family: 'codex' });
  recordNextIdle(board, { agentId: builder, reason: 'nothing-eligible' });
  register(board, { lane: 'tests', path: '/family-seat' });
  register(board, { lane: 'tests', path: '/family-seat', family: 'codex' });
  assert.deepEqual(events(board).filter(event => event.event_kind === 'family').map(event => JSON.parse(event.event_detail).family), ['codex'], 'a later join that names a family writes one family event');
  register(board, { lane: 'docs', path: '/builder', model: 'Fixture Model' });
  const reviewer = register(board, { lane: 'tests', path: '/reviewer', family: 'Fixture Review' });
  setLaneLead(board, { agentId: coordinator, lane: 'docs', seat: builder, lanes: ['docs', 'tests'] });
  const laneWorker = register(board, { lane: 'docs', path: '/lane-worker' });
  const laneQuestion = shout(board, { from: laneWorker, to: coordinator, text: 'sample lane escalation', decision: true, lanes: ['docs', 'tests'] });
  passDecision(board, laneQuestion, { agentId: builder, note: 'Needs coordination', lanes: ['docs', 'tests'] });
  setLaneLead(board, { agentId: coordinator, lane: 'docs', seat: null, lanes: ['docs', 'tests'] });
  register(board, { lane: 'small', path: '/small', route: 'light' });
  ensureCoordinator(board, '/coordinator-moved');
  shout(board, { from: builder, to: 'all', text: 'sample announcement', lanes: ['docs', 'tests'] });
  shout(board, { from: coordinator, to: 'all', text: 'sample explicit release news', lanes: ['docs', 'tests'], news: true });
  const passed = shout(board, { from: builder, to: coordinator, text: 'sample decision', lanes: ['docs', 'tests'], decision: true });
  assert.throws(
    () => passDecision(board, passed, { agentId: builder, note: 'try to pass it', lanes: ['docs', 'tests'] }),
    (error) => error?.code === 'COORDINATOR_ONLY',
    'the pass actor restriction is enforced by the board code',
  );
  passDecision(board, passed, { agentId: coordinator, note: 'ask the person', lanes: ['docs', 'tests'] });
  const personQuestion = shout(board, { from: coordinator, to: PERSON, text: 'sample person decision', lanes: ['docs', 'tests'], decision: true });
  answerDecision(board, personQuestion, { agentId: coordinator, text: 'approved', lanes: ['docs', 'tests'], asPerson: true });
  const request = shout(board, { from: PERSON, to: coordinator, text: 'sample request', lanes: ['docs', 'tests'], request: true });
  answerDecision(board, request, { agentId: coordinator, text: 'done', lanes: ['docs', 'tests'] });
  const deliveryQuestion = shout(board, { from: builder, to: coordinator, text: 'sample delivery question', decision: true, lanes: ['docs', 'tests'] });
  answerDecision(board, deliveryQuestion, { agentId: coordinator, text: 'sample delivery answer', lanes: ['docs', 'tests'] });
  const deliveryEvent = events(board).findLast(event => event.event_kind === 'answer');
  recordActivityDelivery(board, { agentId: builder, through: deliveryEvent.event_id, digestThrough: deliveryEvent.event_id,
    interrupts: [{ id: `event:${deliveryEvent.event_id}`, eventId: deliveryEvent.event_id, reason: 'answered' }] });
  actOnActivity(board, { agentId: builder, ids: [`event:${deliveryEvent.event_id}`] });
  const decisions = recordRowDecisions(board, { agentId: PERSON, channel: 'terminal', decisions: [{ kind: 'spec', file: 'SPEC.md', id: 'A1', source: '- A1 [draft] Exact row.', replacement: '- A1 [approved] Exact row.', text: 'Exact row.', decision: 'approve', reason: '' }] });
  applyRowDecisions(board, { agentId: coordinator, events: decisions.map((record) => record.event), refreezes: [] });
  draftSpecRow(board, { agentId: builder, row: { id: 'A2', text: 'A lane drafted row.', gate: 'review', tier: 'must', section: 'A · Fixture' } });
  const freeze = (digest) => () => ({ text: `criterion-${digest}`, digest });
  // Real historical ordered envelopes retain the 142 field shape, not modern policy defaults.
  const legacyAdd = { ...prepareEngineMove(board, 'addItem', [{ by: coordinator, lane: 'docs', title: 'Historical family event', reviewFamily: 'Fixture Review' }]), engine: 142 };
  const legacyAdded = applyEngineMove(board, legacyAdd, { sequence: 1, at: '2026-10-17T19:58:00.000Z' });
  assert.equal(legacyAdded.error, undefined);
  const legacyEdit = { ...prepareEngineMove(board, 'editItem', [legacyAdded.result, { agentId: coordinator, reviewFamily: 'Fixture Review' }]), engine: 142 };
  assert.equal(applyEngineMove(board, legacyEdit, { sequence: 2, at: '2026-10-17T19:59:00.000Z' }).error, undefined);
  const first = addItem(board, { by: coordinator, lane: 'docs', title: 'Accepted example', criterion: 'Initial', specIds: ['A1'], route: 'strong', reviewFamily: 'Fixture Review', checkTiming: false });
  const fact = appendFact(board, first, { agentId: builder, kind: 'note', text: 'Captured evidence', ref: 'docs/formats.md:1-3@' + 'a'.repeat(40) });
  appendFact(board, first, { agentId: coordinator, kind: 'measurement', text: 'Corrected evidence', supersedes: fact.id });
  editItem(board, first, { agentId: coordinator, title: 'Accepted example, retitled', brief: 'Files: docs/formats.md\nTest: docs/formats.test.js', route: 'mid', criterion: 'Changed', check: 'node test', reviewFamily: 'Fixture Review', checkTiming: false });
  const dependency = addItem(board, { by: coordinator, lane: 'docs', title: 'Dependency example' });
  requestCompanion(board, { agentId: builder, parentId: dependency, lane: 'core', key: 'format-event', title: 'Companion event example' });
  editItem(board, first, { agentId: coordinator, after: [dependency] });
  const implying = appendFact(board, first, { agentId: coordinator, kind: 'decision', text: 'Dependency changes', implies: [dependency] });
  appendFact(board, first, { agentId: coordinator, kind: 'supersession', text: 'Dependency changes again', supersedes: implying.id });
  const asked = shout(board, { from: builder, to: coordinator, text: 'implying decision', lanes: ['docs', 'tests'], decision: true });
  const implyingAnswer = answerDecision(board, asked, { agentId: coordinator, text: 'yes', lanes: ['docs', 'tests'], implies: [dependency] });
  const askedAgain = shout(board, { from: builder, to: coordinator, text: 'superseding decision', lanes: ['docs', 'tests'], decision: true });
  answerDecision(board, askedAgain, { agentId: coordinator, text: 'no', lanes: ['docs', 'tests'], supersedes: implyingAnswer });
  editItem(board, first, { agentId: coordinator, after: [] });
  // The coordinator's reversible machine-verification mark on an open item records `machineVerification` on its edit.
  editItem(board, first, { agentId: coordinator, machineVerified: false });
  holdItem(board, first, { agentId: coordinator, reason: 'fixture item hold' });
  releaseItemHold(board, first, { agentId: coordinator });
  recordAttempt(board, first, { agentId: builder, n: 1, seconds: 2, result: 'failed' });
  claim(board, first, { agentId: builder, lane: 'docs', leaseMs: 60_000, freeze: freeze('first') });
  claim(board, first, { agentId: builder, lane: 'docs', leaseMs: 60_000, freeze: freeze('unused') });
  escalate(board, first, { agentId: builder, note: 'attempted once', attempt: '1' });
  claim(board, first, { agentId: builder, lane: 'docs', leaseMs: 60_000, freeze: freeze('unused') });
  // The automatic rejection escalation carries the two rejection receipts in the same event.
  escalate(board, first, { agentId: coordinator, note: 'two rejects on the route', rejections: [{ receipt: 'r1', reason: 'TEST_FAILURE' }, { receipt: 'r2', reason: 'TEST_FAILURE' }] });
  claim(board, first, { agentId: builder, lane: 'docs', leaseMs: 60_000, freeze: freeze('unused') });
  release(board, first, builder, 'Recorded format example returns the claim before refreezing.', undefined, 'OTHER');
  editItem(board, first, { agentId: coordinator, criterion: 'Updated after claim', reason: 'the claimed bar named the wrong field' });
  refreeze(board, first, { agentId: coordinator, freeze: freeze('second') });
  claim(board, first, { agentId: builder, lane: 'docs', leaseMs: 60_000, freeze: freeze('unused') });
  const acceptedCommit = 'a'.repeat(40);
  // Synthetic metadata exercises the optional event shape; real Git counting is tested separately.
  submitFixture(board, first, { agentId: builder, commit: acceptedCommit, tree: 'b'.repeat(40), files: ['docs/formats.md'], policyCommit: 'a'.repeat(40),
    submissionSize: { base: 'c'.repeat(40), head: acceptedCommit, lines: 100, method: 'added-plus-deleted-no-renames' } });
  reserveReview(board, first, { agentId: reviewer, leaseMs: 60_000, policy: 'agents' });
  verify(board, first, { agentId: reviewer, decision: 'ACCEPT', reason: ACCEPT_REASON, note: 'checked the example', head: acceptedCommit, digest: 'second', policy: 'agents', implies: [dependency] });
  verify(board, first, { agentId: reviewer, decision: 'ACCEPT', note: 'checked a newer composition',
    head: 'd'.repeat(40), digest: 'second', policy: 'agents',
    review: { commit: acceptedCommit, head: 'd'.repeat(40), trunk: 'b'.repeat(40), paths: ['docs/formats.md'] } });
  // A machine acceptance needs sealed native receipts, which this fixture cannot mint; its event shape is recorded synthetically here.
  logEvent(board, reviewer, 'accept', first, { reason: ACCEPT_REASON, commit: acceptedCommit, note: 'machine-verified: frozen check (receipt fixture)',
    review: { commit: acceptedCommit, head: acceptedCommit, trunk: 'b'.repeat(40), paths: ['docs/formats.md'] },
    machine: { version: 1, commands: [{ clause: 0, command: 'true', receipt: 'fixture' }] } });
  merged(board, first, { agentId: coordinator, commit: 'c'.repeat(40) });
  const batch = recordLandingBatch(board, { agentId: coordinator, batch: { version: 1, id: 'format-example', base: 'a'.repeat(40), tip: 'c'.repeat(40),
    root: '/landing', branch: 'refs/heads/main', state: 'pushed', owner: 'format-example', logPath: '/landing.log', items: [{ id: first, commit: acceptedCommit, merge: 'c'.repeat(40) }] } });
  recordLandingWaiver(board, { agentId: PERSON, channel: 'terminal', id: 'format-waiver', test: 'test/flaky.test.js', until: '2099-01-01', reason: 'format example' });
  recordLandingFlake(board, { agentId: coordinator, test: 'test/flaky.test.js', hash: 'd'.repeat(64), names: ['flaky example'], lane: 'docs', batchId: batch.id });
  // Exercise the new event's historical-engine semantics here; team-engine.test.js
  // separately prepares and compares this path with the actual released engine 12.
  const olderFinish = { ...prepareEngineMove(board, 'finishLandingBatch', [{ agentId: coordinator, id: batch.id, tip: batch.tip }]), engine: 12 };
  assert.equal(applyEngineMove(board, olderFinish, { sequence: 3, at: '2026-10-17T20:00:00.000Z' }).error, undefined);

  const rejected = addItem(board, { by: coordinator, lane: 'docs', title: 'Rejected example', criterion: 'The fixture passes.' });
  /** This rejection quotes the exact criterion frozen for this example. */
  const rejectedFreeze = () => ({ text: JSON.stringify({ criterion: 'The fixture passes.', rows: [] }), digest: 'rejected' });
  claim(board, rejected, { agentId: builder, lane: 'docs', leaseMs: 60_000, freeze: rejectedFreeze });
  const rejectedCommit = 'd'.repeat(40);
  submitFixture(board, rejected, { agentId: builder, commit: rejectedCommit, tree: 'e'.repeat(40) });
  verify(board, rejected, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', note: 'the fixture failed', clause: 'The fixture passes.', head: rejectedCommit, digest: 'rejected', policy: 'agents', implies: [dependency],
    review: { commit: rejectedCommit, head: rejectedCommit, trunk: 'a'.repeat(40), paths: ['docs/formats.md'] } });
  claim(board, rejected, { agentId: builder, lane: 'docs', leaseMs: 60_000, freeze: rejectedFreeze });
  const repeatedCommit = '9'.repeat(40);
  submitFixture(board, rejected, { agentId: builder, commit: repeatedCommit, tree: '8'.repeat(40) });
  verify(board, rejected, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE',
    note: 'the same fixture still fails', clause: 'The fixture passes.', head: repeatedCommit, digest: 'rejected', policy: 'agents' });

  const ceiling = addItem(board, { by: coordinator, lane: 'docs', title: 'Strong route notice example', route: 'strong',
    criterion: 'The title renders. The footer renders.' });
  /** Different clauses exercise the existing strong-route notice without a repeated-clause hold. */
  const ceilingFreeze = () => ({ text: JSON.stringify({ criterion: 'The title renders. The footer renders.', rows: [] }), digest: 'strong-notice' });
  for (const [head, clause] of [['6'.repeat(40), 'The title renders.'], ['7'.repeat(40), 'The footer renders.']]) {
    claim(board, ceiling, { agentId: builder, lane: 'docs', leaseMs: 60_000, freeze: ceilingFreeze });
    submitFixture(board, ceiling, { agentId: builder, commit: head, tree: '8'.repeat(40) });
    verify(board, ceiling, { agentId: reviewer, decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH',
      note: 'the named rendered part is missing', clause, head, digest: 'strong-notice', policy: 'agents' });
  }

  assert.ok(events(board).some(row => row.item_id === ceiling && row.event_kind === 'strong-rejection-notice'),
    'distinct-clause rejects retain the existing strong-route notice');

  const corrected = addItem(board, { by: coordinator, lane: 'docs', title: 'Corrected live claim' });
  claim(board, corrected, { agentId: builder, lane: 'docs', leaseMs: 60_000, freeze: freeze('before-correction') });
  editItem(board, corrected, { agentId: coordinator, criterion: 'Corrected criterion', reason: 'the fixture corrects its bar' });
  assert.deepEqual(JSON.parse(events(board).filter((row) => row.event_kind === 'edit').at(-1).event_detail).pendingRefreeze, ['criterion']);
  refreeze(board, corrected, { agentId: builder, freeze: freeze('adopted-correction') });
  const widener = register(board, { lane: 'docs', path: '/widener' });
  const widened = addItem(board, { by: coordinator, lane: 'docs', title: 'Widened own check', check: 'node apps/cli/src/io/run/tests.js docs/formats.test.js' });
  claim(board, widened, { agentId: widener, lane: 'docs', leaseMs: 60_000, freeze: freeze('before-widening') });
  const widenedCheck = 'node apps/cli/src/io/run/tests.js docs/formats.test.js apps/cli/journeys/init/docs.test.js';
  const widenedBar = JSON.stringify({ criterion: '', check: widenedCheck });
  editItem(board, widened, { agentId: widener, check: widenedCheck, correction: true, freeze: () => ({ text: widenedBar, digest: createHash('sha256').update(widenedBar).digest('hex') }) });
  assert.deepEqual(JSON.parse(events(board).filter((row) => row.event_kind === 'edit').at(-1).event_detail).widenedCheck, ['apps/cli/journeys/init/docs.test.js'], 'a builder widening is the one edit that carries widenedCheck');

  const returnedBuilder = register(board, { lane: 'docs', path: '/returned-builder', model: 'builder' });
  const returned = addItem(board, { by: coordinator, lane: 'docs', title: 'Returned landing example' });
  claim(board, returned, { agentId: returnedBuilder, lane: 'docs', leaseMs: 60_000, freeze: freeze('returned') });
  const returnedCommit = 'f'.repeat(40);
  submitFixture(board, returned, { agentId: returnedBuilder, commit: returnedCommit, tree: 'e'.repeat(40) });
  verify(board, returned, { agentId: reviewer, decision: 'ACCEPT', reason: ACCEPT_REASON, note: 'checked the returned example', head: returnedCommit, digest: 'returned', policy: 'agents' });
  const failureBatch = recordLandingBatch(board, { agentId: coordinator, batch: { version: 1, id: 'format-red-example', base: 'a'.repeat(40), tip: 'c'.repeat(40),
    root: '/landing-red', branch: 'refs/heads/main', state: 'blocked', owner: 'format-red-example', logPath: '/landing-red.log',
    items: [{ id: returned, commit: returnedCommit }], culprits: [{ id: returned, commit: returnedCommit, mergeCommit: 'c'.repeat(40),
      tests: [{ file: 'test/format.test.js', name: 'keeps the example' }] }] } });
  reopen(board, returned, { agentId: coordinator, note: `Landing batch ${failureBatch.id} failed test/format.test.js: keeps the example; merge commit ${'c'.repeat(40)}` });

  const conflicting = addItem(board, { by: coordinator, lane: 'docs', title: 'Conflicting example' });
  claim(board, conflicting, { agentId: returnedBuilder, lane: 'docs', leaseMs: 60_000, freeze: freeze('conflicting') });
  const conflictingCommit = '1'.repeat(40);
  submitFixture(board, conflicting, { agentId: returnedBuilder, commit: conflictingCommit, tree: 'e'.repeat(40) });
  verify(board, conflicting, { agentId: reviewer, decision: 'ACCEPT', reason: ACCEPT_REASON, note: 'checked the conflicting example', head: conflictingCommit, digest: 'conflicting', policy: 'agents' });
  reopen(board, conflicting, { agentId: coordinator, conflict: { files: ['docs/formats.md'], trunk: '2'.repeat(40) } });

  const withdrawnAcceptance = addItem(board, { by: coordinator, lane: 'docs', title: 'Withdrawn acceptance example' });
  claim(board, withdrawnAcceptance, { agentId: returnedBuilder, lane: 'docs', leaseMs: 60_000, freeze: freeze('withdrawn-acceptance') });
  const withdrawnCommit = '3'.repeat(40);
  submitFixture(board, withdrawnAcceptance, { agentId: returnedBuilder, commit: withdrawnCommit, tree: 'e'.repeat(40) });
  verify(board, withdrawnAcceptance, { agentId: reviewer, decision: 'ACCEPT', reason: ACCEPT_REASON,
    note: 'checked the withdrawal format example', head: withdrawnCommit, digest: 'withdrawn-acceptance', policy: 'agents' });
  const originalVerdict = board.db.prepare('SELECT * FROM verdict WHERE item_id = ?').get(withdrawnAcceptance);
  const originalAccept = events(board).findLast(row => row.item_id === withdrawnAcceptance && row.event_kind === 'accept');
  reopen(board, withdrawnAcceptance, { agentId: reviewer, withdrawVerdict: true, note: 'correct the accepted interpretation' });
  const withdrawalDetail = JSON.parse(events(board).findLast(row => row.item_id === withdrawnAcceptance && row.event_kind === 'reopen').event_detail);
  assert.deepEqual(withdrawalDetail.withdrawnVerdict, { verdictId: originalVerdict.verdict_id, acceptEventId: originalAccept.event_id });
  assert.equal(withdrawalDetail.supersedes, originalAccept.event_id);
  assert.deepEqual(board.db.prepare('SELECT * FROM verdict WHERE item_id = ?').get(withdrawnAcceptance), originalVerdict,
    'the format binding leaves the accepted verdict immutable');
  assert.deepEqual(events(board).find(row => row.event_id === originalAccept.event_id), originalAccept,
    'the format binding leaves the original accept event immutable');

  const withdrawn = addItem(board, { by: coordinator, lane: 'docs', title: 'Withdrawn example' });
  withdraw(board, withdrawn, { agentId: coordinator, reason: 'duplicate fixture' });
  holdLane(board, 'view', { agentId: coordinator, reason: 'fixture hold' });
  releaseLane(board, 'view', { agentId: coordinator });
  recordSigningEvents(board, coordinator);
  appendFact(board, first, { agentId: coordinator, kind: 'root-cause', text: 'A typed immediate Rigor format example', cause: 'doctrine:C3', neverAgain: true, asPerson: true, channel: 'terminal' });
  // A synthetic health observation exercises receipt fields only; the health tests prove scanning.
  const healthFinding = { key: `CLAIM_LAPSED:item:${corrected}`, cause: 'CLAIM_LAPSED', item: corrected,
    subject: `#${corrected}`, title: 'claim lapsed', since: '2026-10-17T19:00:00.000Z',
    why: 'the format example names its owner', next: `pullboard claim ${corrected}`, owner: { who: builder } };
  const revision = () => events(board).at(-1)?.event_id ?? 0;
  recordHealthFindings(board, { agentId: coordinator, observedRevision: revision(), findings: [healthFinding] });
  recordHealthFindings(board, { agentId: coordinator, observedRevision: revision(), findings: [] });
  const unattendedBuilder = exerciseRejectedWorkFormat(board, { coordinator, reviewer });
  // These synthetic receipts exercise both append-only event formats, not real diagnostic execution.
  for (const id of ['format-first', 'format-second']) recordFlakeObservation(board, {
    agentId: coordinator, lane: 'docs', observation: syntheticFlakeObservation(id, true),
  });
  // Synthetic automatic-Submit quarantine: only its detail shape is claimed; the native Submit journeys prove how it is filed.
  logEvent(board, coordinator, 'test-quarantine', first, { engine: AUTO_SUBMIT_QUARANTINE_ENGINE, autoSubmit: true,
    file: 'test/synthetic.test.js', name: 'synthetic submit target', tree: 'b'.repeat(40), runs: ['format-submit-first', 'format-submit-second'] });
  // Explicitly synthetic event-contract history; no external command or gate is claimed.
  const watch = proposeSentinel(board, { agentId: coordinator, row: { name: 'format-watch', check: 'false', every: 'daily', owner: 'coordinator' } });
  decideSentinel(board, { agentId: PERSON, channel: 'view', name: watch.name, digest: watch.digest, decision: 'approve' });
  beginSentinelRun(board, { agentId: coordinator, name: watch.name, digest: watch.digest, run: 'format-run' });
  finishSentinelRun(board, { agentId: coordinator, name: watch.name, digest: watch.digest, run: 'format-run',
    result: { green: false, code: 1, timedOut: false, durationMs: 0, output: 'synthetic format receipt' } });
  // Synthetic numeric summaries exercise the documented event shape, not provider attribution.
  const usageRecords = [{ model: 'Fixture', inputTokens: null, outputTokens: null,
    knownInputTokens: 0, knownOutputTokens: 0, wallMs: 1, unknownReasons: ['native-session-unavailable'] }];
  recordUsage(board, { agentId: builder, item: first, revision: 1, observedAt: 1, records: usageRecords });
  recordSharedUsage(board, { agentId: builder, id: '00000000-0000-0000-0000-000000000056',
    seats: [builder, returnedBuilder], allocations: [{ seat: builder, item: first }, { seat: returnedBuilder, item: returned }],
    revision: 1, observedAt: 2, records: usageRecords });
  recordRelayExclusionIntent(board, 'view'); // Synthetic person format fixture, not a real settings opt-out.
  // Exercise the optional omission through native decisions and replay validation, not a fabricated event.
  const omitted = addItem(board, { by: coordinator, lane: 'docs', title: 'Unfrozen draft citation format',
    criterion: 'A stored format example.', check: 'true', specIds: ['Z1', 'Z2'] });
  const omissionDecisions = recordRowDecisions(board, { agentId: PERSON, channel: 'terminal', decisions: [
    { kind: 'spec', file: 'SPEC.md', id: 'Z1', source: '- Z1 [approved] Original format promise. | gate: true',
      replacement: '- Z1 [approved] Corrected format promise. | gate: true', text: 'Corrected format promise.', decision: 'approve', reason: '' },
    { kind: 'spec', file: 'SPEC.md', id: 'Z2', source: '- Z2 [draft] Optional draft promise. | gate: true',
      replacement: '- Z2 [wont] Optional draft promise. | gate: true', text: 'Optional draft promise.', decision: 'decline', reason: 'Not needed.' },
  ] });
  const omissionMove = prepareEngineMove(board, 'applyRowDecisions', [{ agentId: coordinator,
    events: omissionDecisions.map(record => record.event), refreezes: [], skippedDrafts: [omitted] }]);
  assert.equal(applyEngineMove(board, omissionMove, { sequence: appliedSequence(board) + 1, at: board.clock.now().toISOString() }).error, undefined);
  // One coordinator session's usage goes through its own ordered move, as the live coordinator records it.
  const usageMove = prepareEngineMove(board, 'recordCoordinatorUsage', [{ agentId: coordinator, session: 'format-session', observedAt: 5, records: usageRecords }]);
  assert.equal(applyEngineMove(board, usageMove, { sequence: appliedSequence(board) + 1, at: board.clock.now().toISOString() }).error, undefined);
  const rows = events(board).map((row) => ({ ...row, detail: JSON.parse(row.event_detail) }));
  closeBoard(board);
  return { rows, actors: { [coordinator]: 'coordinator', [builder]: 'builder', [returnedBuilder]: 'builder', [widener]: 'builder', [unattendedBuilder]: 'builder', [reviewer]: 'reviewer', [PERSON]: 'person', board: 'board', rigor: 'rigor' } };
}

/** Exercise automatic placement and both authorized override actors for the event manifest [A5,B35,N26]. */
function placementEventContract() {
  const board = openBoard(':memory:');
  try {
    ensureCoordinator(board, '/format-placement-coordinator');
    addMilestone(board, { agentId: COORDINATOR, name: 'N' });
    addMilestone(board, { agentId: COORDINATOR, name: 'M' });
    const item = addItem(board, { by: COORDINATOR, lane: 'core', title: 'Placement event format' });
    editMilestoneItems(board, 'M', { agentId: COORDINATOR, add: [item], reason: 'format coordinator override' });
    editMilestoneItems(board, 'N', { agentId: PERSON, add: [item], reason: 'format person override' });
    return events(board).filter(row => row.event_kind === 'milestone_placed')
      .map(row => ({ ...row, detail: JSON.parse(row.event_detail) }));
  } finally { closeBoard(board); }
}

/** Reopen a file after removing old-format objects and report the repaired guard event. */
function exerciseUpgrade() {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-formats-'));
  const file = join(directory, 'board.sqlite');
  let board;
  try {
    board = openBoard(file);
    assert.equal(board.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION,
      'opening an older board advances its schema version in place');
    ensureCoordinator(board, join(directory, 'coordinator'));
    addItem(board, { by: COORDINATOR, lane: 'docs', title: 'Preserved row' });
    assert.equal(board.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    const originalEvents = events(board).length;
    closeBoard(board);
    board = null;

    const old = new DatabaseSync(file);
    old.exec("ALTER TABLE shout DROP COLUMN shout_evidence_kind; DROP TABLE hold; DROP INDEX item_lane_status; DROP TRIGGER machine_event_delete; DROP TRIGGER machine_event_update; CREATE TRIGGER machine_event_update AFTER DELETE ON event BEGIN SELECT 1; END; CREATE TRIGGER machine_old_extra AFTER INSERT ON item BEGIN SELECT 1; END; PRAGMA user_version = 1;");
    old.close();
    // The refusal of a schema-1 board is proved in packages/store/tests/io/board/too-old.test.js (#7767); this file keeps its five board-file opens.
    const supported = new DatabaseSync(file);
    // Schema 3 is the oldest supported version, so an event log marker at the unversioned state is what makes the board behind, and it migrates.
    supported.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; DELETE FROM board_meta WHERE meta_key = 'event_log_version'`);
    supported.close();

    board = openBoard(file);
    assert.equal(board.db.prepare("SELECT item_title FROM item").get().item_title, 'Preserved row');
    assert.ok(board.db.prepare('PRAGMA table_info(shout)').all().some((column) => column.name === 'shout_evidence_kind'));
    assert.ok(board.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hold'").get());
    assert.ok(board.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'item_lane_status'").get());
    assert.equal(board.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'machine_old_extra'").get(), undefined);
    assert.equal(board.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    const repair = events(board).find((row) => row.event_kind === 'guards');
    assert.ok(repair, 'reopening reports repaired/missing/stale guards in the event log');
    assert.equal(events(board).length, originalEvents + 1, 'reopening preserves old events and appends one guard-repair event');
    assert.deepEqual(JSON.parse(repair.event_detail), {
      missing: ['machine_event_delete'], changed: ['machine_event_update'], stale: ['machine_old_extra'],
    });
    return events(board).map((row) => ({ ...row, detail: JSON.parse(row.event_detail) }));
  } finally {
    if (board) closeBoard(board);
    rmSync(directory, { recursive: true, force: true });
  }
}

test('clause 1: [A5] schema, versions, event kinds and event detail fields match live behavior', async t => {
  const board = openBoard(':memory:');
  try {
    const version = board.db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(version, SCHEMA_VERSION);
    assert.deepEqual(documentedColumns('<!-- board-columns:start -->', '<!-- board-columns:end -->'), liveColumns(board.db, 'main'));
    assert.deepEqual(documentedColumns('<!-- temp-columns:start -->', '<!-- temp-columns:end -->'), liveColumns(board.db, 'temp'));
    assert.deepEqual(documentedTriggers('<!-- board-triggers:start -->', '<!-- board-triggers:end -->'), liveTriggers(board.db, 'main'));
    assert.deepEqual(documentedTriggers('<!-- temp-triggers:start -->', '<!-- temp-triggers:end -->'), liveTriggers(board.db, 'temp'));
    assert.deepEqual(documentedIndexes(), liveIndexes(board.db));
    assert.deepEqual(documentedUpgradeConditions(), [
      ['Missing declared tables or indexes', 'Create them with `CREATE ... IF NOT EXISTS`.'],
      ['Missing declared columns', 'Add each with `ALTER TABLE ... ADD COLUMN` and its declared default.'],
      ['Missing or changed declared triggers', 'Install the declared trigger definitions.'],
      ['Undeclared `machine_` triggers', 'Drop them as stale.'],
      ['A board that previously had guard triggers', 'Append a `guards` event listing missing, changed and stale trigger names.'],
      ['An older schema version', 'Set `PRAGMA user_version` to the current `SCHEMA_VERSION` after installation.'],
      ['Existing rows and event history', 'Keep them in the same board file; guard repair may append its `guards` event.'],
    ]);
    const versions = block('<!-- format-versions:start -->', '<!-- format-versions:end -->');
    const versionOf = (name) => {
      const match = new RegExp('^\\| `' + name + '` \\| `(\\d+)` \\|', 'm').exec(versions);
      assert.ok(match, `guide declares ${name} version`);
      return Number(match[1]);
    };
    assert.equal(versionOf('CLI JSON envelope'), JSON_SHAPES.version);
    assert.equal(versionOf('row grammar'), SPEC_GRAMMAR_VERSION);
    assert.equal(versionOf('board schema'), SCHEMA_VERSION);
    assert.equal(versionOf('event log'), EVENT_LOG_VERSION);
  } finally {
    closeBoard(board);
  }

  const { rows, actors } = recordEventContract();
  const repairedRows = exerciseUpgrade();
  const actualRows = [...rows, ...repairedRows, ...await sourceAdvanceEventContract(t), ...reviewDefaultEventContract(), ...pipelineEventContract(), ...placementEventContract()];
  const actual = {};
  const actorByKind = {
    join: 'joining agent',
    family: 'agent',
    model: 'agent',
    moved: 'coordinator',
    'lane-lead': 'coordinator',
    add: 'item creator',
    milestone_placed: 'item creator or override actor',
    companion: 'requesting agent',
    edit: 'editor',
    attempt: 'reporting agent',
    fact: 'author',
    usage: 'builder',
    'shared-usage': 'participant',
    guards: 'board',
    'rigor-notice': 'rigor',
    'rigor-draft': 'rigor',
    shout: 'sender',
    'activity-delivered': 'recipient',
    'activity-acted': 'recipient',
    'next-idle': 'idle seat',
    shout_news: 'sender',
    pass: 'coordinator',
    answer: 'answerer',
    'flake-observation': 'reporting agent',
    'flake-repair': 'reporting agent',
    'test-quarantine': 'reporting agent',
    'health-scan': 'observing agent',
    'health-failure': 'sentinel',
    'health-resolved': 'sentinel',
    'sentinel-proposal': 'proposing agent',
    'sentinel-decision': 'person',
    'sentinel-start': 'running agent',
    'sentinel-run': 'running agent',
    'sentinel-failure': 'sentinel',
    person_proposal: 'proposing agent',
    source_advanced: 'coordinator',
  };
  for (const row of actualRows) {
    const kind = row.event_kind;
    const entry = actual[kind] ?? { actors: new Set(), fields: new Set() };
    const actor = kind === 'person_signing' && row.event_by !== PERSON ? 'enabling agent'
      : kind === 'pass' && row.event_by !== COORDINATOR ? 'lane lead'
      : kind === 'refreeze' && row.event_by !== COORDINATOR
      ? 'live holder adopting a pending correction'
      : actorByKind[kind] ?? actors[row.event_by] ?? 'unknown';
    entry.actors.add(actor);
    for (const field of Object.keys(row.detail)) {
      if (field !== 'model') entry.fields.add(field);
    }
    actual[kind] = entry;
  }
  const documented = documentedEvents();
  assert.deepEqual(Object.keys(documented).sort(), Object.keys(actual).sort());
  assert.match(block('<!-- pass-rule:start -->', '<!-- pass-rule:end -->'), /passDecision` only for the coordinator/);
  for (const [kind, expected] of Object.entries(documented)) {
    assert.deepEqual([...actual[kind].actors].sort(), expected.actor.split(', or ').sort());
    assert.deepEqual([...actual[kind].fields].sort(), expected.fields);
  }
});
