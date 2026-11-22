/** Proposed sentinel watches wait in the view's Needs-you list, and its approve and decline carry the CLI's decision [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERSON } from '../../../../packages/store/index.js';
import { events } from '../../../../packages/store/index.js';
import { moveArgs } from '../../../../packages/person/light.js';
import { decideSentinel } from '../../../../packages/sentinels/index.js';
import { proposeSentinel } from '../../../../packages/sentinels/index.js';
import { sentinels } from '../../../../packages/sentinels/index.js';
import { cellBoard } from '../../../../packages/board/tests/fixtures/cell-board.js';
import { cellProject } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../packages/store/tests/fixtures/cell.js';
import { apiBoardOpeners } from '../../../cli/tests/fixtures/board.js';
import { projectState } from '../../src/io/serve.js';

/** A real private board whose coordinator has proposed the named watches. */
function proposed(t, names) {
  const project = cellProject(t, { real: true, gate: 'true' });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  cellSeat(board, { lane: 'coordinator', path: project.repo });
  for (const name of names) {
    proposeSentinel(board, { agentId: 'coordinator', row: { name, check: 'node checks/' + name + '.js', every: 'hourly', owner: 'coordinator' } });
  }
  return { project, board };
}

/** The sentinel decisions the board holds, as written. */
function decisions(board) {
  return events(board, { kinds: ['sentinel-decision'] }).map((event) => ({ by: event.event_by, ...JSON.parse(event.event_detail) }));
}

test('view.io-needs.sentinel-drafts-listed: clause 1: a proposed sentinel watch awaiting the person appears in the view with its command, directory and schedule [N26]', (t) => {
  const { project, board } = proposed(t, ['file-size']);
  const state = projectState(project.repo, { board, boardOpeners: apiBoardOpeners });
  const draft = state.needs.find((need) => need.kind === 'sentinel-draft');
  assert.ok(draft, 'the proposed watch is a Needs-you entry');
  assert.equal(draft.ref, 'file-size');
  assert.equal(draft.check, 'node checks/file-size.js', 'the command it would run');
  assert.equal(draft.directory, '.', 'the directory it would run in');
  assert.equal(draft.every, 'hourly', 'its schedule');
  assert.equal(draft.digest, sentinels(board)[0].digest, 'the exact proposal digest a decision must carry');
  assert.deepEqual(state.sentinelDrafts.map((row) => row.ref), ['file-size']);
});

test('view.io-needs.sentinel-approve-records-cli-decision: clause 2: approving a sentinel draft from the view sends the CLI move and records the decision pullboard sentinel approve records [N26]', (t) => {
  const { board } = proposed(t, ['file-size', 'line-count']);
  const [viewDraft, cliDraft] = sentinels(board);
  // The view's Approve press is this move; it runs the CLI's own sentinel approve with the digest the person was shown.
  assert.deepEqual(moveArgs({ verb: 'sentinel-approve', args: { name: viewDraft.name, digest: viewDraft.digest } }),
    ['sentinel', 'approve', '--digest=' + viewDraft.digest, '--json', '--', 'file-size']);
  // That CLI run records one person decision through decideSentinel, in the view's channel; the terminal records the same in its own.
  decideSentinel(board, { agentId: PERSON, channel: 'view', name: viewDraft.name, digest: viewDraft.digest, decision: 'approve' });
  decideSentinel(board, { agentId: PERSON, channel: 'terminal', name: cliDraft.name, digest: cliDraft.digest, decision: 'approve' });
  const [byView, byCli] = decisions(board);
  assert.deepEqual({ ...byView, name: '', digest: '', channel: '' }, { ...byCli, name: '', digest: '', channel: '' });
  assert.equal(byView.by, PERSON);
  assert.equal(byView.decision, 'approve');
  assert.equal(byView.channel, 'view');
  assert.deepEqual(sentinels(board).map((row) => row.status), ['approved', 'approved']);
  assert.throws(() => decideSentinel(board, { agentId: 'coordinator', channel: 'view', name: 'file-size', digest: viewDraft.digest, decision: 'approve' }),
    { code: 'B26_PERSON_APPROVAL' }, 'only the person decides');
});

test('view.io-needs.sentinel-decline-records-reason: clause 2: declining a sentinel draft from the view needs a reason and records the decline the CLI records [N26]', (t) => {
  const { board } = proposed(t, ['file-size']);
  const [draft] = sentinels(board);
  assert.throws(() => moveArgs({ verb: 'sentinel-decline', args: { name: draft.name, digest: draft.digest } }), { code: 'BAD_REQUEST' }, 'the view move refuses a blank reason');
  assert.deepEqual(moveArgs({ verb: 'sentinel-decline', args: { name: draft.name, digest: draft.digest, reason: 'Too slow to run hourly' } }),
    ['sentinel', 'decline', '--digest=' + draft.digest, '--reason=Too slow to run hourly', '--json', '--', 'file-size']);
  decideSentinel(board, { agentId: PERSON, channel: 'view', name: draft.name, digest: draft.digest, decision: 'decline', reason: 'Too slow to run hourly' });
  const [recorded] = decisions(board);
  assert.equal(recorded.by, PERSON);
  assert.equal(recorded.decision, 'decline');
  assert.equal(recorded.reason, 'Too slow to run hourly');
  assert.equal(sentinels(board)[0].status, 'declined');
});
