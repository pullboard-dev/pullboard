/** Repeated instructions become pending mechanism drafts through real shout transactions [C7,D1,H16]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import * as rigor from '../../../../packages/rigor/index.js';
import * as state from '../../../../packages/state/index.js';
import { shout as shoutMove } from '../../../../packages/moves/index.js';
import { openBoard } from '../../../lib/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

/** Give each test a real durable board, controlled clock and independent sender identities. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-instructions-'));
  const file = join(directory, 'board.sqlite');
  const now = new Date('2026-11-02T12:00:00Z');
  // @pullboard-board-file persistence: drafts must survive a reopen of the same file
  const board = openBoard(file, { now: () => new Date(now) });
  t.after(() => { store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  store.board_ensureCoordinator(board, directory);
  store.register(board, { lane: 'core', path: join(directory, 'core-1'), model: 'Fixture builder' });
  /** Send through the public transaction; no fixture inserts drafts or edits stored messages. */
  const send = (to, text, extra = {}) => store.shout(board, { from: 'coordinator', to, text, lanes: ['core'], ...extra });
  return { board, file, now, send };
}

test('a repeated coordinator instruction drafts the mechanism that replaces it [C7,D1]', t => {
  const box = fixture(t);
  const ids = [box.send('all', 'Merge main before submitting.'), box.send('core-1', 'Merge main into your branch.')];
  assert.equal(store.rowDrafts(box.board).length, 0, 'two instructions are below the default threshold');
  ids.push(box.send('core', 'Rebase onto main before the next submit.'));
  const [draft] = store.rowDrafts(box.board);
  assert.ok(draft, 'the third instruction itself creates the mechanism proposal');
  assert.equal(draft.target, 'spec');
  assert.equal(draft.gate, 'review');
  assert.equal(draft.written, false);
  assert.match(draft.text, /Submit detects a moved main/u);
  assert.match(draft.text, /No mechanism is enforced until the person approves/u);
  const source = store.readAutomaticRigorSource(store.automaticSourceFromText(draft.text));
  assert.equal(source.key, 'instruction:merge-main');
  assert.equal(source.evidence.occurrences, 3);
  const evidence = store.events(box.board).filter(event => source.evidence.events.includes(event.event_id));
  assert.deepEqual(evidence.map(event => JSON.parse(event.event_detail).shout), ids);
  assert.ok(evidence.every(event => event.event_by === 'coordinator' && event.event_kind === 'shout'));
  box.send('all', 'Merge main again.');
  assert.equal(store.rowDrafts(box.board).length, 1, 'one durable draft per instruction kind');
  assert.deepEqual(store.rowDecisions(box.board), [], 'drafting grants no approval');
  // @pullboard-board-file persistence: reopening the file proves the drafts are durable
  const reopened = openBoard(box.file, { now: () => new Date(box.now) });
  try {
    const needs = store.automaticRigorNeeds({ spec: [], practice: [] }, store.rowDrafts(reopened));
    assert.equal(needs.length, 1, 'the ordinary person decision path can read the durable source');
    assert.equal(needs[0].cause, 'instruction:merge-main');
    assert.equal(needs[0].unproved, true);
    assert.equal(needs[0].proof, null);
  } finally { store.closeBoard(reopened); }
});

test('instruction counts distinguish all six kinds, direct messages and compound instructions [C7]', () => {
  const phrases = { assignment: 'Claim #1270.', focus: 'Focus on the speed work.', freeze: 'Pause new submissions.',
    'merge-main': 'Merge main before submit.', refreeze: 'Refreeze #1270 to current policy.', routing: 'Switch to #2392 instead.' };
  for (const [kind, text] of Object.entries(phrases)) assert.deepEqual(rigor.coordinatorInstructionKinds(text), [kind]);
  assert.deepEqual(rigor.coordinatorInstructionKinds('Claim #1270 and merge main.'), ['assignment', 'merge-main']);
  assert.deepEqual(rigor.coordinatorInstructionKinds('The measured check is green.'), []);
  const shouts = Object.entries(phrases).map(([kind, text], index) => ({ shout_id: index + 1, shout_from: 'coordinator',
    shout_to: index % 2 ? 'core-1' : 'all', shout_text: text, shout_at: '2026-11-02T11:00:00Z', shout_answers: null }));
  const report = rigor.coordinatorInstructionReport(shouts, { now: '2026-11-02T12:00:00Z' });
  assert.deepEqual(report.kinds.map(entry => entry.count), [1, 1, 1, 1, 1, 1]);
  assert.equal(report.threshold, 3);
  assert.equal(report.windowMs, 7 * 86_400_000);
});

test('the rolling window excludes old, future, duplicate, non-coordinator and reply messages [C7]', () => {
  const message = { shout_id: 1, shout_from: 'coordinator', shout_to: 'all', shout_text: 'Merge main.',
    shout_at: '2026-10-26T12:00:00Z', shout_answers: null };
  const shouts = [message, message, { ...message, shout_id: 2, shout_at: '2026-10-26T11:59:59Z' },
    { ...message, shout_id: 3, shout_at: '2026-11-03T12:00:00Z' }, { ...message, shout_id: 4, shout_from: 'core-1' },
    { ...message, shout_id: 5, shout_answers: 10 }, { ...message, shout_id: 6, shout_request: true }];
  const report = rigor.coordinatorInstructionReport(shouts, { now: '2026-11-02T12:00:00Z', threshold: 2 });
  assert.equal(report.kinds.find(entry => entry.kind === 'merge-main').count, 1);
  assert.equal(report.threshold, 2);
});

test('old shout engines do not draft; new coordinator moves declare their side-effect engine [C7,H16]', t => {
  const box = fixture(t);
  box.board.executionEngineVersion = state.RIGOR_INSTRUCTIONS_ENGINE - 1;
  for (let index = 0; index < 3; index++) box.send('all', 'Merge main.');
  assert.equal(store.rowDrafts(box.board).length, 0);
  box.board.executionEngineVersion = state.RIGOR_INSTRUCTIONS_ENGINE;
  box.send('core-1', 'Merge main.');
  assert.equal(store.rowDrafts(box.board).length, 1);
  assert.ok(shoutMove.minimumEngine([{ from: 'coordinator' }]) >= state.RIGOR_INSTRUCTIONS_ENGINE);
  assert.ok(shoutMove.minimumEngine([{ from: 'core-1' }]) < state.RIGOR_INSTRUCTIONS_ENGINE);
});

test('the person can decline a materialized instruction proposal through the existing spec path [C7,D1,S1]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  /** Require real native command success before reading its result. */
  const json = async (...args) => { const ran = await box.runLocal(box.repo, ...args, '--json'); assert.equal(ran.code, 0, ran.out + ran.err); return JSON.parse(ran.out); };
  for (let index = 0; index < 3; index++) await json('shout', 'all', 'Merge main before submit.');
  const report = await json('rigor');
  assert.equal(report.instructions.kinds.find(entry => entry.kind === 'merge-main').count, 3);
  await json('spec', 'apply');
  const row = (await json('spec')).rows.find(row => row.text.includes('Source: rigor-auto:') && row.text.includes('coordinator merge-main'));
  assert.ok(row);
  assert.equal(row.status, 'draft');
  await json('spec', 'decline', row.id, '--reason', 'Use a different mechanism.');
  assert.ok((await json('log')).events.some(event => event.event_kind === 'row_decision'));
});
