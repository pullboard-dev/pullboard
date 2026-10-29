/** A strict item no active seat could review is refused at submit and named by the sentinel [C7,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { fixtureBoard } from './board-fixture.js';
import { submitPreflight } from '../src/submit-preflight.js';
import { heartbeatSeat } from '../src/seat-presence.js';
import { refuseUnreviewable } from '../src/review-reachability.js';
import { refuseLiveAttach } from '../src/item-patches.js';
import { healthReport } from '../src/health.js';
import { FAMILY_DECLARE_ENGINE } from '../src/family-declare-engine.js';

const LEASE = 3_600_000;
const freeze = () => ({ text: '{}', digest: 'synthetic-review-bar' });
const REVIEW = { policy: 'any', familyPolicy: 'require' };

/** Live seats of the named families; the coordinator declares none, so it can never review strict work. */
function fixture(t, seats, clock) {
  const board = fixtureBoard(t, { clock });
  store.register(board, { id: 'coordinator', lane: 'coordinator', path: '/fixture/coordinator', parentDigest: 'e'.repeat(64), model: 'Synthetic fixture model' });
  store.setLineSetting(board, { agentId: 'coordinator', key: 'requireReviewFamilies', value: true, reason: 'Private fixture selects its vendor policy.', window: { syntheticSeats: 6 } });
  for (const [id, family, parent] of seats) {
    store.register(board, { id, lane: 'core', path: `/fixture/${id}`, family, parentDigest: parent.repeat(64), model: 'Synthetic fixture model' });
    heartbeatSeat(board, id);
  }
  const claimed = (builder) => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Strict fixture', sensitive: true });
    store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: LEASE, freeze });
    return id;
  };
  const credit = (id, agentId) => board.db.prepare('INSERT OR REPLACE INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(`item_patches:${id}`,
    JSON.stringify({ version: 1, patches: [{ key: 'companion', commit: 'c'.repeat(40), digest: 'd'.repeat(64), active: true, author: { agentId, parentSession: null, session: null } }] }));
  const preflight = (id, builder) => submitPreflight(board, id, { agentId: builder, commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, { atomic: store.atomic, submit: store.submit }, { refuse: (board, item) => refuseUnreviewable(board, item, REVIEW) });
  return { board, claimed, credit, preflight };
}

test('an OpenAI builder with a Claude-credited companion on a strict item is refused by name [C7,V4]', t => {
  const f = fixture(t, [['core-1', 'openai', 'a'], ['core-2', 'claude', 'b'], ['core-3', 'claude', 'c'], ['core-4', 'openai', 'd']]);
  const id = f.claimed('core-1');
  f.credit(id, 'core-2');
  const before = store.events(f.board);
  assert.throws(() => f.preflight(id, 'core-1'), error => {
    assert.equal(error.code, 'NO_ELIGIBLE_REVIEWER');
    for (const name of ['builder core-1 (openai)', 'companion author core-2 (claude)', 'credit the companion to a custodian of another family', 'declare the missing family']) {
      assert.ok(`${error.message} ${error.next ?? ''}`.includes(name), `names ${name}: ${error.message}`);
    }
    return true;
  });
  assert.deepEqual(store.events(f.board), before, 'a refused preflight records nothing');
  assert.equal(store.getItem(f.board, id).item_status, 'claimed');
});

test('the same item with an OpenAI-credited companion submits [C7,V4]', t => {
  const f = fixture(t, [['core-1', 'openai', 'a'], ['core-2', 'claude', 'b'], ['core-3', 'claude', 'c'], ['core-4', 'openai', 'd']]);
  const id = f.claimed('core-1');
  f.credit(id, 'core-4');
  f.preflight(id, 'core-1');
});

test('a null-family builder on a strict item is refused naming the missing declaration [C7,V4]', t => {
  const f = fixture(t, [['core-1', undefined, 'a'], ['core-2', 'claude', 'b']]);
  const id = f.claimed('core-1');
  assert.throws(() => f.preflight(id, 'core-1'), error => /declared no vendor family/u.test(error.message) && /--family/u.test(error.message),
    'the builder-family guard predates this check and still speaks first');
});

test('seats with no declared family leave strict review unroutable and are named [C7,V4]', t => {
  const f = fixture(t, [['core-1', 'openai', 'a'], ['core-2', undefined, 'b'], ['core-3', undefined, 'c']]);
  const id = f.claimed('core-1');
  assert.throws(() => f.preflight(id, 'core-1'), error => error.code === 'NO_ELIGIBLE_REVIEWER'
    && /core-2, core-3 declare no vendor family/u.test(error.message));
  store.register(f.board, { lane: 'core', path: '/fixture/core-3', family: 'claude', parentDigest: 'c'.repeat(64), model: 'Synthetic fixture model' });
  f.preflight(id, 'core-1');
});

test('a seat that is gone does not count as an active reviewer [C7,V4]', t => {
  let ms = Date.parse('2026-10-28T12:00:00Z');
  const f = fixture(t, [['core-1', 'openai', 'a'], ['core-2', 'claude', 'b']], { now: () => new Date(ms) });
  const id = f.claimed('core-1');
  f.preflight(id, 'core-1');
  ms += 40 * 60_000;
  heartbeatSeat(f.board, 'core-1');
  assert.throws(() => f.preflight(id, 'core-1'), { code: 'NO_ELIGIBLE_REVIEWER' }, 'the only eligible seat has been quiet past thirty minutes');
  heartbeatSeat(f.board, 'core-2');
  f.preflight(id, 'core-1');
});

test('the sentinel names an already-submitted strict item that became unreviewable [C7,V4]', t => {
  const f = fixture(t, [['core-1', 'openai', 'a'], ['core-2', 'claude', 'b']]);
  const id = f.claimed('core-1');
  store.submit(f.board, id, { agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40), files: [],
    submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'synthetic board-state fixture; no gate execution' } });
  const config = { verify: REVIEW };
  const report = () => healthReport({ db: f.board.db, root: process.cwd(), config, now: f.board.clock.now(), dispatchHealth: () => ({ findings: [] }) });
  assert.equal(report().stuck.some(entry => entry.cause === 'NO_ELIGIBLE_REVIEWER'), false, 'a claude seat can review it');
  f.credit(id, 'core-2');
  const found = report().stuck.find(entry => entry.cause === 'NO_ELIGIBLE_REVIEWER');
  assert.ok(found, 'crediting a claude companion leaves no reviewer');
  assert.ok(found.why.includes('builder core-1 (openai)') && found.why.includes('companion author core-2 (claude)'), found.why);
});

const PATCH = 'diff --git a/x.txt b/x.txt\nnew file mode 100644\n--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1 @@\n+x\n';
/** Attach a coordinator companion patch credited to one author, exactly as the native move receives it. */
const attach = (f, id, key, author) => store.attachItemPatch(f.board, id, { agentId: 'coordinator', key, commit: 'c'.repeat(40), patch: PATCH, author, presubmit: true });

test('attaching a Claude-credited companion to a claimed OpenAI-built strict item is refused and changes nothing [C7,V4]', t => {
  const f = fixture(t, [['core-1', 'openai', 'a'], ['core-2', 'claude', 'b'], ['core-3', 'claude', 'c'], ['core-4', 'openai', 'd']]);
  const id = f.claimed('core-1');
  const before = store.events(f.board);
  assert.throws(() => attach(f, id, 'companion', 'core-2'), error => error.code === 'NO_ELIGIBLE_REVIEWER'
    && error.message.includes('builder core-1 (openai)') && error.message.includes('companion author core-2 (claude)'));
  assert.deepEqual(store.events(f.board), before, 'the refused attach recorded nothing');
  assert.equal(attach(f, id, 'companion', 'core-4').changed, true, 'an OpenAI-credited companion still attaches');
});

test('historical family clears cannot hide the builder or companion from strict reachability [C7,V4,H16]', t => {
  const f = fixture(t, [['core-1', 'openai', 'a'], ['core-2', 'claude', 'b'], ['core-3', 'openai', 'c']]);
  const id = f.claimed('core-1');
  f.board.executionEngineVersion = FAMILY_DECLARE_ENGINE - 1;
  try {
    for (const [agent, parent] of [['core-1', 'a'], ['core-2', 'b']]) {
      store.register(f.board, { lane: 'core', path: `/fixture/${agent}`, family: null, parentDigest: parent.repeat(64), model: 'Synthetic fixture model' });
    }
  } finally { delete f.board.executionEngineVersion; }
  const before = store.events(f.board);
  assert.throws(() => attach(f, id, 'cleared-companion', 'core-2'), error => error.code === 'NO_ELIGIBLE_REVIEWER'
    && error.message.includes('builder core-1 (openai)') && error.message.includes('companion author core-2 (claude)'));
  assert.deepEqual(store.events(f.board), before, 'a refused attach leaves the historical clears factual and adds no event');
});

test('a live attach is refused when the only eligible reviewer is gone, while replaying the recorded move succeeds [C7,V4]', t => {
  let ms = Date.parse('2026-10-28T12:00:00Z');
  const f = fixture(t, [['core-1', 'openai', 'a'], ['core-2', 'claude', 'b'], ['core-3', 'openai', 'c']], { now: () => new Date(ms) });
  const id = f.claimed('core-1');
  ms += 40 * 60_000;
  heartbeatSeat(f.board, 'core-1');
  heartbeatSeat(f.board, 'core-3');
  const item = store.getItem(f.board, id);
  const before = store.events(f.board);
  const live = () => refuseLiveAttach(f.board, item, { key: 'companion', author: 'core-3' }, { atomic: store.atomic, review: REVIEW });
  assert.throws(live, error => error.code === 'NO_ELIGIBLE_REVIEWER' && error.message.includes('companion author core-3 (openai)'));
  assert.deepEqual(store.events(f.board), before, 'the live preview records nothing');
  assert.equal(attach(f, id, 'companion', 'core-3').changed, true, 'the ordered move counts registered seats, so replay succeeds');
  heartbeatSeat(f.board, 'core-2');
  assert.doesNotThrow(() => refuseLiveAttach(f.board, store.getItem(f.board, id), { key: 'other', author: 'core-3' }, { atomic: store.atomic, review: REVIEW }), 'once the reviewer is active again the live check passes');
});
