/** @pullboard-test-input apps/cli/pullboard.js */
/** Real HTTP state: summaries, details, deltas and milestone status against the actual board engine (A2). */
import {
  viewApiPorts,
} from '../../../../view/index.js';
import {
  apiBoardOpeners,
} from '../../../tests/fixtures/board.js';
import assert from 'node:assert/strict';
import {
  runFixtureGit,
} from '../../../tests/fixtures/child.js';
import {
  writeFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  WHOLE_STATE_DELTA_FIELDS,
  serveApi,
} from '../../../../../packages/api/index.js';
import {
  refusalDocument,
} from '../../../index.js';
import {
  main,
} from '../../../tests/fixtures/native.js';
import {
  applyStateDelta,
} from '../../../../../packages/api/index.js';
import {
  apiHttpFixture as fixture,
} from '../../../tests/fixtures/api.js';
import {
  apiHttpBox as httpBox,
} from '../../../tests/fixtures/api.js';
import {
  fetchFresh,
} from '../../../tests/fixtures/http.js';
import {
  commitWork,
  submitSettled,
  checkOutSubmitted,
  withoutClaimHealth,
  FIXTURE_BRIEF,
} from '../../../tests/fixtures/api.js';

test("[A2, N26] a sent-back item's summary carries its reject note's first line", async (t) => {
  const box = await httpBox(t);
  const builder = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-builder', '--family', 'codex');
  const verifier = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-verifier', '--family', 'claude');
  /** Make one real board move through HTTP and return its result. */
  async function move(body) {
    const moved = await box.call(box.path + '/moves', body);
    assert.equal(moved.status, 200, JSON.stringify(moved.document));
    return moved.document.result;
  }
  /** Build an item to submission and reserve its review for the verifier. */
  async function submitted(title) {
    const id = (await move({ verb: 'add', args: { lane: 'app', title, criterion: 'shows a greeting', specs: 'G1', brief: FIXTURE_BRIEF } })).item.item_id;
    await move({ verb: 'claim', item: id, agent: builder.agent });
    commitWork(box, builder, id); await submitSettled(t, box, move, id, builder.agent);
    checkOutSubmitted(box, builder, verifier); await move({ verb: 'next', agent: verifier.agent, args: { verify: true } });
    return id;
  }
  const note = 'The page shows no greeting.\nThe second line stays in the detail.';
  const rejected = await submitted('Rejected item');
  await move({ verb: 'verify', item: rejected, agent: verifier.agent, args: { decision: 'reject', reason: 'BEHAVIOR_MISMATCH', note, clause: 'shows a greeting' } });
  const accepted = await submitted('Accepted item');
  await move({ verb: 'verify', item: accepted, agent: verifier.agent, args: { decision: 'accept', reason: 'CRITERION_MET', note: 'The page greets by name.\nChecked twice.' } });

  const summaries = new Map((await box.call(box.path + '/state')).document.state.items.map((item) => [item.id, item]));
  assert.deepEqual(summaries.get(rejected).verdict, { decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH', note: 'The page shows no greeting.' },
    'a sent-back row keeps its reason and the first line of the note');
  assert.deepEqual(summaries.get(accepted).verdict, { decision: 'ACCEPT', reason: 'CRITERION_MET' }, 'an accepted item carries no note');
  assert.equal((await box.call(box.path + '/items/' + rejected)).document.item.verdict.note, note, 'the whole note stays in the detail');

  // A verdict hands the verifier the next build, which is the item it just sent back; the builder takes it from there.
  await move({ verb: 'release', item: rejected, agent: verifier.agent, args: { reason: 'ROUTED_ELSEWHERE' } });
  await move({ verb: 'claim', item: rejected, agent: builder.agent });
  const reworked = (await box.call(box.path + '/state')).document.state.items.find((item) => item.id === rejected);
  assert.equal(reworked.verdict.note, 'The page shows no greeting.', 'a row being reworked still says why');
  const full = (await box.call(box.path + '/state?detail=full')).document.state.items.find((item) => item.id === rejected);
  assert.deepEqual({ ...reworked, ...(await box.call(box.path + '/items/' + rejected)).document.item }, withoutClaimHealth(full), 'the detail still completes the summary');
});

test('[A2, N26] a delta brings a snapshot up to date', async (t) => {
  const box = await httpBox(t);
  writeFileSync(join(box.root, 'SPEC.md'), '# HTTP fixture\n\n## Goals\n- G1 [approved, must] Keep the board. | gate: true\n- G2 [pending, must] Keep each delta small. | gate: true\n');
  runFixtureGit(['commit', '-qam', 'docs: ask whether deltas stay small'], { cwd: box.root, env: box.env, stdio: 'pipe' });
  const builder = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-builder', '--family', 'codex');
  const verifier = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-verifier', '--family', 'claude');
  /** Make one real board move through HTTP and return its result. */
  async function move(body) {
    const moved = await box.call(box.path + '/moves', body);
    assert.equal(moved.status, 200, JSON.stringify(moved.document));
    return moved.document.result;
  }
  const item = (await move({ verb: 'add', args: { lane: 'app', title: 'Delta item', criterion: 'moves through review', specs: 'G1', brief: FIXTURE_BRIEF } })).item.item_id;
  const waiting = (await move({ verb: 'add', args: { lane: 'app', title: 'Waiting item', criterion: 'stays open', specs: 'G1', after: String(item), brief: FIXTURE_BRIEF } })).item.item_id;

  const first = (await box.call(box.path + '/state')).document.state;
  assert.ok(Number.isSafeInteger(first.sequence), 'a snapshot names the event it reflects');
  let held = first;
  /**
   * Ask for what changed since the held snapshot, apply it, and compare it with a fresh snapshot
   * read at the same instant, so the flow observation in both is the same.
   */
  async function catchUp(label, observedAt = Date.now()) {
    t.mock.timers.enable({ apis: ['Date'], now: observedAt });
    try {
      // A submit's handoff worker may append its own events between the two reads; compare only a pair read at one sequence.
      let answer = await box.call(box.path + '/state?since=' + held.sequence);
      let fresh = await box.call(box.path + '/state');
      for (let attempt = 0; attempt < 200 && answer.document.sequence !== fresh.document.state?.sequence; attempt += 1) {
        answer = await box.call(box.path + '/state?since=' + held.sequence);
        fresh = await box.call(box.path + '/state');
      }
      assert.equal(answer.status, 200, label);
      assert.ok(answer.document.delta, `${label}: ${JSON.stringify(answer.document.reset)}`);
      assert.equal(answer.document.since, held.sequence, label);
      assert.equal(answer.document.sequence, fresh.document.state.sequence, `${label}: the delta names the new latest sequence`);
      assert.equal(answer.document.eventLogVersion, fresh.document.eventLogVersion, label);
      const updated = applyStateDelta(held, answer.document.delta);
      assert.deepEqual(updated, fresh.document.state, `${label}: the delta brings the snapshot up to date`);
      assert.ok(JSON.stringify(answer.document).length < JSON.stringify(fresh.document).length, `${label}: the delta is smaller than a snapshot`);
      held = updated;
      return answer.document.delta;
    } finally {
      t.mock.timers.reset();
    }
  }
  const changed = (delta, field) => (delta.merge[field]?.set ?? []).map((entry) => entry[delta.merge[field].key]);

  await move({ verb: 'claim', item, agent: builder.agent });
  const claimed = await catchUp('claim');
  assert.deepEqual(changed(claimed, 'items'), [item], 'only the claimed item travels');
  assert.equal(claimed.merge.items.set[0].claim.by, builder.agent);
  assert.equal(Object.hasOwn(claimed.merge.items, 'ids'), false, 'no item came or went, so the order is not sent');
  const unchangedSequence = held.sequence;
  const nextObservation = Date.parse(held.observedAt) + 1; // One logical clock tick; no board move or timed wait.
  const still = await catchUp('only the observation clock changed', nextObservation);
  assert.equal(held.sequence, unchangedSequence, 'advancing the observation clock writes no board event');
  assert.equal(still.replace.observedAt, new Date(nextObservation).toISOString(),
    'even a no-event delta must refresh the held snapshot observation time');
  assert.deepEqual(still.merge, {}, 'an unchanged board merges nothing');
  assert.deepEqual(Object.keys(still.replace).sort(), [...WHOLE_STATE_DELTA_FIELDS, 'claimOverlaps'].sort(),
    'only the declared per-read projections and small decision lists travel whole');
  assert.deepEqual(still.replace.decisionQueue, [], 'the unchanged empty coordinator queue travels as a whole field');

  commitWork(box, builder, item); await submitSettled(t, box, move, item, builder.agent);
  assert.equal((await catchUp('submit')).merge.items.set[0].status, 'submitted');

  checkOutSubmitted(box, builder, verifier); await move({ verb: 'next', agent: verifier.agent, args: { verify: true } });
  await move({ verb: 'verify', item, agent: verifier.agent, args: { decision: 'accept', reason: 'CRITERION_MET', note: 'read every delta' } });
  const verdict = await catchUp('verdict');
  assert.deepEqual(changed(verdict, 'items').sort((a, b) => a - b), [item, waiting], 'the accept also unblocks the item waiting on it');

  const asked = await move({ verb: 'shout', agent: builder.agent, args: { to: 'coordinator', text: 'May the delta skip the order?', kind: 'question', decision: true } });
  const shouted = await catchUp('shout');
  assert.ok(changed(shouted, 'shouts').includes(asked.id), 'the new shout travels');
  assert.ok(changed(shouted, 'asked').includes(asked.id), 'and so does the open question');
  assert.ok(shouted.replace.decisionQueue.some(row => row.shout_id === asked.id), 'the coordinator queue carries its actual new question');
  const answered = await move({ verb: 'answer', item: asked.id, args: { text: 'Only when nothing moved.' } });
  const answer = await catchUp('answer');
  assert.ok(changed(answer, 'shouts').includes(answered.id), 'the answer travels');
  assert.ok(answer.merge.asked.ids.every((id) => id !== asked.id), 'the answered question leaves the open list');
  assert.ok(answer.replace.decisionQueue.every(row => row.shout_id !== asked.id), 'the answered question also leaves the coordinator queue');

  await box.cliLocal(box.root, 'spec', 'approve', 'G2');
  const decided = await catchUp('spec decision');
  assert.deepEqual(changed(decided, 'spec'), ['G2'], 'only the decided spec row travels');

  writeFileSync(join(box.root, 'DOCTRINE.md'), '# Local rules\n\n## Team Rules\n\n- LOCAL1 [approved, must] Keep each delta exact. | gate: true\n');
  const unmoved = held.sequence;
  const edited = await catchUp('a doctrine edit without a move');
  assert.equal(held.sequence, unmoved, 'no event, so the sequence holds');
  assert.ok(changed(edited, 'practice').includes('LOCAL1'), 'the doctrine row travels anyway');
  await catchUp('again at the same sequence, which may repeat the edit but still applies exactly');

  held = first;
  await catchUp('every move at once, from the first snapshot');

  const ahead = await box.call(box.path + '/state?since=' + (held.sequence + 1000));
  assert.equal(ahead.status, 200);
  assert.equal(ahead.document.delta, null);
  assert.equal(ahead.document.reset.code, 'BASE_AHEAD');
  assert.match(ahead.document.reset.next, /\/state/);
  const format = await box.call(box.path + '/state?since=' + held.sequence + '&eventLogVersion=0');
  assert.equal(format.document.delta, null);
  assert.equal(format.document.reset.code, 'FORMAT_CHANGED', 'a snapshot in another event-log format is never extended');
  // A restarted server that has only read an item, or searched, never sent a snapshot: it cannot
  // extend the held one, even when a change with no event leaves the sequence where it was.
  writeFileSync(join(box.root, 'DOCTRINE.md'), '# Local rules\n\n## Team Rules\n\n- LOCAL1 [approved, must] A restarted server knows only what it sent. | gate: true\n');
  const restarted = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, projects: () => [{ root: box.root, name: 'HTTP fixture' }] });
  t.after(() => restarted.close());
  const restartedUrl = new URL(restarted.url);
  /** Read through the restarted server with its own key. */
  const restartedRead = async (path) => (await fetchFresh(restartedUrl.origin + box.path + path, { headers: { 'x-pullboard-key': restartedUrl.searchParams.get('k') } })).json();
  assert.equal((await restartedRead('/items/' + item)).item.id, item);
  assert.deepEqual((await restartedRead('/items?q=delta')).ids, [item]);
  const unknownDocument = await restartedRead('/state?since=' + held.sequence);
  assert.equal(unknownDocument.delta, null, JSON.stringify(unknownDocument.delta));
  assert.equal(unknownDocument.reset.code, 'BASE_NOT_KEPT', 'a server that never sent that snapshot says so instead of guessing');
  const resent = (await restartedRead('/state')).state;
  assert.equal(resent.sequence, held.sequence, 'the doctrine edit wrote no event');
  assert.notDeepEqual(resent.practice, held.practice, 'so the held snapshot really is stale');
  assert.equal((await restartedRead('/state?since=' + held.sequence)).delta === null, false, 'once it sends a snapshot at that sequence, it can extend it');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const extended = applyStateDelta(resent, (await restartedRead('/state?since=' + resent.sequence)).delta);
    assert.deepEqual(extended, (await restartedRead('/state')).state, 'and its delta still brings that snapshot up to date');
  } finally {
    t.mock.timers.reset();
  }
  for (const [query, code] of [['since=', 'BAD_CURSOR'], ['since=-1', 'BAD_CURSOR'], ['since=1.5', 'BAD_CURSOR'], ['since=1&detail=full', 'BAD_REQUEST']]) {
    const refused = await box.call(box.path + '/state?' + query);
    assert.equal(refused.status, 400, query);
    assert.equal(refused.document.error.code, code, query);
  }
});

test('[A2, N26] local milestone item status refreshes after an item event', async (t) => {
  let builds = 0;
  const box = await httpBox(t, { onStateBuild: () => { builds += 1; } });
  const agent = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-agent');
  const added = await box.call(box.path + '/moves', {
    verb: 'add', args: { lane: 'app', title: 'Roadmap item', criterion: 'refresh local status', specs: 'G1', brief: FIXTURE_BRIEF },
  });
  assert.equal(added.status, 200);
  const itemId = added.document.result.item.item_id;
  await box.cliLocal(box.root, 'milestone', 'add', 'Delivery', '--reason', 'Arrange fixture release', '--items', String(itemId));

  const before = await box.call(box.path + '/state');
  assert.equal(builds, 1);
  console.log('DBG', JSON.stringify(before.document.state.milestones).slice(0,1200));
  const { progress: beforeProgress, ...beforeItem } = before.document.state.milestones[0].items[0];
  assert.equal(beforeProgress.stage, 'open');
  assert.deepEqual(beforeItem, {
    id: itemId, title: 'Roadmap item', status: 'open', state: 'open', position: 1,
  });

  const unchanged = await box.call(box.path + '/state');
  assert.equal(builds, 1, 'an unchanged local roadmap state reuses its cached snapshot');
  assert.deepEqual(unchanged.document.state.milestones, before.document.state.milestones);

  const claimed = await box.call(box.path + '/moves', { verb: 'claim', item: itemId, agent: agent.agent });
  assert.equal(claimed.status, 200);
  const after = await box.call(box.path + '/state');
  assert.equal(builds, 2, 'a real item event rebuilds the cached local roadmap');
  const { progress: afterProgress, ...afterItem } = after.document.state.milestones[0].items[0];
  assert.equal(afterProgress.stage, 'claimed');
  assert.deepEqual(afterItem, {
    id: itemId, title: 'Roadmap item', status: 'claimed', state: 'claimed', position: 1,
  });
});
