/**
 * A land job that posts push-failed is offered again, up to a bound, then the coordinator hears a named refusal; and a
 * runner whose code predates the job's payload shape refuses it with a named code instead of pushing [C7,#7791].
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from '../../../../../packages/git/index.js';
import { jobQueueCall } from '../../../../../packages/api/index.js';
import { offerLandingJob } from '../../../../../packages/api/index.js';
import { applyLandingReceipt } from '../../../../../packages/api/index.js';
import { LAND_PAYLOAD_SHAPE } from '../../../../../packages/api/index.js';
import { runLandingJob } from '../../../../../packages/landing/index.js';
import { addItem } from '../../../../../packages/store/index.js';
import { register } from '../../../../../packages/store/index.js';
import { claim } from '../../../../../packages/store/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { verify } from '../../../../../packages/store/index.js';
import { itemThread } from '../../../../../packages/store/index.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { fixtureCommittedGraph } from '../../../tests/fixtures/testkit.js';
import { FIXTURE_MODEL } from '../../../tests/fixtures/testkit.js';

/** A board with one accepted item, whose commit is the fixture repo's head. */
function accepted(t) {
  const graph = fixtureCommittedGraph('pullboard-push-failed-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  graph.put('package.json', '{ "type": "module" }\n');
  graph.put('pullboard.json', '{ "lanes": {} }\n');
  const sha = graph.commit();
  const board = cellBoard(t, ':memory:', undefined, { gitRoot: graph.root });
  const actor = register(board, { lane: 'core', path: join(graph.root, 'b'), route: 'strong', model: FIXTURE_MODEL });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Item', criterion: 'The item lands.' });
  const frozen = JSON.stringify({ criterion: 'The item lands.' });
  const digest = createHash('sha256').update(frozen).digest('hex');
  claim(board, id, { agentId: actor, lane: 'core', leaseMs: 3_600_000, head: sha, freeze: () => ({ text: frozen, digest }) });
  submitFixture(board, id, { agentId: actor, commit: sha, tree: git(graph.root, ['rev-parse', `${sha}^{tree}`]) });
  verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'fixture acceptance', head: sha, digest, policy: 'any' });
  return { board, id, sha };
}

/** Claim the one open land job as a stub runner and post a push-failed receipt for it; return the applied result. */
function failPush(board) {
  const call = body => jobQueueCall(board.db, body, { mode: 'pull' });
  const { claim: taken } = call({ action: 'claim', runner: 'stub', capabilities: [], kinds: ['land'] });
  const receipt = { kind: 'land', outcome: 'push-failed', detail: 'refusing to update checked out branch', landed: [], already: [], returned: [], attempts: 1, moved: [], phases: [] };
  call({ action: 'receipt', job: taken.job, runner: 'stub', token: taken.token, receipt });
  return { job: taken.job, applied: applyLandingReceipt(board, { job: taken.job, receipt }) };
}

test('clause 1: a land job whose push failed is offered again, then names LAND_PUSH_FAILED to the coordinator [C7,#7791]', t => {
  const { board, id, sha } = accepted(t);
  offerLandingJob(board.db, { items: [{ id, commit: sha }], expect: sha, config: { trunk: { remote: '/nowhere.git' } } });
  const jobs = [];
  for (let round = 0; round < 3; round++) {
    const claimed = failPush(board);
    jobs.push(claimed.job);
    const open = board.db.prepare("SELECT job_id FROM job WHERE job_kind = 'land' AND job_step <> 'done'").all();
    assert.equal(open.length, round < 2 ? 1 : 0, `round ${round}: ${JSON.stringify(open)}`);
  }
  assert.equal(new Set(jobs).size, 3, 'each retry is a new job');
  assert.match(jobs[1], /~r1$/u);
  assert.match(jobs[2], /~r2$/u);
  assert.equal(getItem(board, id).item_status, 'verified', 'the item stays accepted');
  const notes = itemThread(board, id).map(entry => entry.text ?? '').filter(text => /push-failed/u.test(text));
  assert.equal(notes.length, 3, JSON.stringify(notes));
  assert.match(notes[0], /offered land job .*~r1 \(retry 1 of 2\)/u);
  assert.match(notes[2], /LAND_PUSH_FAILED/u);
  const shouts = board.db.prepare("SELECT shout_text FROM shout WHERE shout_to = 'coordinator'").all().map(row => row.shout_text);
  assert.ok(shouts.some(text => text.startsWith('LAND_PUSH_FAILED: ') && text.includes(`#${id}`)), JSON.stringify(shouts));
});

test('clause 2: a runner older than the job payload shape refuses it with LANDING_PAYLOAD_VERSION before any git [C7,#7791]', async () => {
  const payload = { shape: LAND_PAYLOAD_SHAPE + 1, remote: '/nowhere.git', trunk: 'refs/heads/main', expect: 'a'.repeat(40), items: [{ id: 1, commit: 'b'.repeat(40) }], checkout: true };
  await assert.rejects(() => runLandingJob(payload, { workdir: '/nonexistent/never-created', checks: async () => ({ ok: true }) }), error => error.code === 'LANDING_PAYLOAD_VERSION' && /\[LANDING_PAYLOAD_VERSION\]/u.test(error.message));
});
