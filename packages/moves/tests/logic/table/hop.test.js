/** The fenced gate hop table: HOP_FENCED on a foreign write, acquire only on a queued or lapsed hop, and generated fault sequences over two drivers [C7,#8068]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOP_ATTEMPT_CAP } from '../../../index.js';
import { HOP_MOVES } from '../../../index.js';
import { hopEngine } from '../../../index.js';
import { explainTable } from '../../../index.js';
import { runTable } from '../../../index.js';
import { seeded } from '../../../index.js';
import { tableCases } from '../../../index.js';

/** Stand-ins for the jobs lease rule, which the wiring item passes in; same shape as packages/jobs rules. */
const LEASE_MS = 120_000;
const leaseLapsed = (leaseUntil, now) => leaseUntil < now;
const { rules: HOP_RULES, table: HOP_TABLE } = hopEngine({ leaseMs: LEASE_MS, leaseLapsed });
const NOW = 1_000_000;
const item = (over = {}) => ({ status: 'claimed', commit: 'c1', digest: 'd1', ...over });
const hop = (over = {}) => ({ state: 'driven', owner: 'a', epoch: 2, leaseUntil: NOW + LEASE_MS, attempts: 0, commit: 'c1', digest: 'd1', ...over });
const snap = (over = {}) => ({ item: item(), hop: hop(), now: NOW, ...over });
const run = (snapshot, move) => runTable(HOP_TABLE, HOP_RULES, snapshot, move);

test('moves.hop.a-step-or-finish-from-a-non-holder: a step or finish from a non-holder or a stale owner epoch is HOP_FENCED, and nothing is written [C7,#8068]', () => {
  for (const name of ['step', 'finish']) {
    for (const move of [{ name, actor: 'b', epoch: 2 }, { name, actor: 'a', epoch: 1 }, { name, actor: 'a', epoch: 3 }, { name, actor: 'a', epoch: undefined }]) {
      const answer = run(snap(), move);
      assert.equal(answer.refused.code, 'HOP_FENCED', JSON.stringify(move));
      assert.equal(answer.refused.row, 'fenced');
      assert.ok(!('patch' in answer));
    }
    assert.ok(!run(snap(), { name, actor: 'a', epoch: 2 }).refused);
  }
  const old = run(snap({ hop: hop({ owner: 'b', epoch: 3 }) }), { name: 'finish', actor: 'a', epoch: 2 });
  assert.equal(old.refused.code, 'HOP_FENCED');
  assert.match(old.refused.message, /owner b at epoch 3/);
});

test('moves.hop.acquire-succeeds-only-on-a-queued-or: acquire succeeds only on a queued or lapsed hop, and bumps the owner epoch [C7,#8068]', () => {
  const queued = run(snap({ hop: hop({ state: 'queued', owner: null, epoch: 0, leaseUntil: 0 }) }), { name: 'acquire', actor: 'b' });
  assert.deepEqual(queued.patch.hop, { ...hop({ state: 'driven', owner: 'b', epoch: 1, leaseUntil: NOW + LEASE_MS }) });
  const lapsed = run(snap({ hop: hop({ leaseUntil: NOW - 1 }) }), { name: 'acquire', actor: 'b' });
  assert.equal(lapsed.patch.hop.epoch, 3);
  assert.equal(lapsed.patch.hop.owner, 'b');
  assert.equal(lapsed.patch.hop.attempts, 1);
  assert.equal(run(snap(), { name: 'acquire', actor: 'b' }).refused.code, 'HOP_HELD');
  assert.equal(run(snap({ hop: hop({ leaseUntil: NOW }) }), { name: 'acquire', actor: 'b' }).refused.code, 'HOP_HELD');
  for (const state of ['done', 'ended']) assert.equal(run(snap({ hop: hop({ state }) }), { name: 'acquire', actor: 'b' }).refused.code, 'HOP_OVER');
  assert.equal(run(snap({ item: item({ commit: 'c2' }), hop: hop({ leaseUntil: NOW - 1 }) }), { name: 'acquire', actor: 'b' }).refused.code, 'HOP_ITEM_MOVED');
});

test('moves.hop.the-third-driver-death-ends-the-hop: the third driver death ends the hop instead of handing it on [C7,#8068]', () => {
  const dead = (attempts) => run(snap({ hop: hop({ leaseUntil: NOW - 1, attempts }) }), { name: 'acquire', actor: 'b' });
  assert.equal(HOP_ATTEMPT_CAP, 3);
  assert.equal(dead(HOP_ATTEMPT_CAP - 2).patch.hop.state, 'driven');
  const capped = dead(HOP_ATTEMPT_CAP - 1);
  assert.deepEqual([capped.via, capped.patch.hop.state, capped.patch.hop.owner], [['cap'], 'ended', null]);
  assert.equal(capped.patch.hop.epoch, 3);
});

test('moves.hop.a-queued-acquire-is-not-a-death: a queued acquire is not a death, create is once per commit, and only an item move ends the hop [C7,#8068]', () => {
  const queuedAgain = run(snap({ hop: hop({ state: 'queued', owner: null, attempts: 2, leaseUntil: 0 }) }), { name: 'acquire', actor: 'b' });
  assert.equal(queuedAgain.patch.hop.attempts, 2);
  const made = run({ item: item(), hop: null, now: NOW }, { name: 'create' });
  assert.deepEqual(made.patch.hop, { state: 'queued', owner: null, epoch: 0, leaseUntil: 0, attempts: 0, commit: 'c1', digest: 'd1' });
  assert.equal(run(snap(), { name: 'create' }).refused.code, 'HOP_EXISTS');
  assert.equal(run({ item: item({ status: 'open' }), hop: null, now: NOW }, { name: 'create' }).refused.code, 'HOP_NOT_WAITING');
  assert.equal(run({ item: item(), hop: null, now: NOW }, { name: 'step', actor: 'a', epoch: 1 }).refused.code, 'HOP_MISSING');
  assert.equal(run(snap(), { name: 'end' }).refused.code, 'HOP_STILL_WAITS');
  for (const moved of [item({ status: 'open' }), item({ commit: 'c2' }), item({ digest: 'd2' })]) {
    const ended = run(snap({ item: moved }), { name: 'end' });
    assert.deepEqual([ended.patch.hop.state, ended.patch.hop.owner, ended.patch.hop.epoch], ['ended', null, 3]);
  }
  assert.equal(run(snap({ item: item({ status: 'open' }) }), { name: 'step', actor: 'a', epoch: 2 }).refused.code, 'HOP_ITEM_MOVED');
  assert.equal(run(snap(), { name: 'nap', actor: 'a' }).refused.code, 'HOP_UNKNOWN_MOVE');
});

test('moves.hop.the-hop-needs-the-job-lease-rule: the hop needs the job lease rule handed in, and its lease length is the table lease [C7,#8068]', () => {
  assert.throws(() => hopEngine({}), { code: 'HOP_LEASE' });
  const queued = hop({ state: 'queued', owner: null, epoch: 0, leaseUntil: 0 });
  const short = hopEngine({ leaseMs: 5, leaseLapsed });
  assert.equal(runTable(short.table, short.rules, snap({ hop: queued }), { name: 'acquire', actor: 'b' }).patch.hop.leaseUntil, NOW + 5);
});

test('moves.hop.explain-reads-the-hop-table-in-order: explain reads the hop table in order from the rule words its guards run [C7,#8068]', () => {
  const explained = explainTable(HOP_TABLE, HOP_RULES);
  assert.equal(explained.guards.find(guard => guard.code === 'HOP_FENCED').says, HOP_RULES.fenced.says);
  assert.deepEqual(explained.outcomes.map(outcome => outcome.id), ['create', 'take', 'retake', 'cap', 'step', 'finish', 'end']);
});

/** A case per move, with breaks that fail each guard's fact in turn. */
function generate(g) {
  const state = g.pick(['queued', 'lapsed', 'live']);
  const base = { item: item(), hop: hop({ attempts: g.int(HOP_ATTEMPT_CAP) }), now: NOW };
  if (state === 'queued') base.hop = hop({ state: 'queued', owner: null, epoch: 0, leaseUntil: 0 });
  if (state === 'lapsed') base.hop.leaseUntil = NOW - 1 - g.int(5);
  const name = g.pick(HOP_MOVES.filter(move => (state === 'queued' ? move !== 'step' && move !== 'finish' : true)));
  const moved = (s) => ({ ...s, item: { ...s.item, commit: 'cX' } });
  if (name === 'create') return { snapshot: { item: item(), hop: null, now: NOW }, move: { name }, breaks: { startable: (s, m) => ({ snapshot: base, move: m }), creatable: (s, m) => ({ snapshot: { ...s, item: item({ status: 'open' }) }, move: m }) } };
  const actor = state === 'live' && (name === 'step' || name === 'finish') ? 'a' : 'b';
  const move = { name, actor, epoch: base.hop.epoch };
  if (name === 'acquire') return state === 'live' ? { snapshot: base, move: { name, actor: 'b' } } : { snapshot: base, move, breaks: { takeable: (s, m) => ({ snapshot: { ...s, hop: { ...s.hop, state: 'done' } }, move: m }), serving: (s, m) => ({ snapshot: moved(s), move: m }) } };
  if (name === 'end') return { snapshot: moved(base), move: { name }, breaks: { endable: (s, m) => ({ snapshot: { ...s, item: item() }, move: m }) } };
  if (state !== 'live') return { snapshot: base, move };
  return { snapshot: base, move, breaks: { fenced: (s, m) => ({ snapshot: s, move: { ...m, epoch: m.epoch + 1 } }), serving: (s, m) => ({ snapshot: moved(s), move: m }), present: (s, m) => ({ snapshot: { ...s, hop: null }, move: m }), live: (s, m) => ({ snapshot: { ...s, hop: { ...s.hop, state: 'done' } }, move: m }) } };
}

test('moves.hop.generated-cases-reach-every-hop-row-never: generated cases reach every hop row, never write while refusing, and fail each guard when its fact is broken [C7,#8068]', () => {
  const report = tableCases(HOP_TABLE, HOP_RULES, generate, { seed: 8068, count: 600 });
  assert.deepEqual(report.writingRefusals, []);
  assert.deepEqual(report.unbroken, []);
  assert.deepEqual(report.unreached.outcomes, []);
});

/** Apply an accepted move to a snapshot, as the board would in one transaction. */
const apply = (state, answer) => ({ ...state, hop: answer.patch.hop ?? state.hop });

/**
 * One fault sequence over two drivers a and b: crashes, blocked loops that resume late, lapses and an item move.
 * Each driver acts only on the epoch it was last given, as a real driver would, so a resumed one writes stale.
 */
function simulate(seed) {
  const g = seeded(seed);
  let state = { item: item(), hop: null, now: NOW };
  const drivers = { a: { epoch: 0, dead: false }, b: { epoch: 0, dead: false } };
  const accepted = [];
  const send = (move) => {
    const before = state;
    const answer = run(before, move);
    if (answer.refused) {
      assert.deepEqual(state, before, `a refusal wrote: ${JSON.stringify(move)}`);
      return answer;
    }
    state = apply(before, answer);
    accepted.push({ move, before, after: state });
    return answer;
  };
  send({ name: 'create' });
  for (let tick = 0; tick < 40; tick++) {
    const who = g.pick(['a', 'b']);
    const driver = drivers[who];
    const roll = g.int(10);
    if (roll < 2) state = { ...state, now: state.now + g.pick([1000, LEASE_MS + 1, LEASE_MS * 2]) };
    else if (roll === 2) driver.dead = true;
    else if (roll === 3 && g.int(6) === 0) state = { ...state, item: item({ status: 'open' }) };
    else if (!driver.dead && roll < 6) {
      const answer = send({ name: 'acquire', actor: who });
      if (!answer.refused) driver.epoch = answer.patch.hop.epoch;
    } else if (!driver.dead && roll < 9) {
      const holds = state.hop.state === 'driven' && state.hop.owner === who && state.hop.epoch === driver.epoch && state.item.status === 'claimed';
      const answer = send({ name: g.int(4) === 0 ? 'finish' : 'step', actor: who, epoch: driver.epoch });
      if (holds) assert.ok(!answer.refused, 'LOST_RESULT: the live holder was refused');
    }
    if (state.item.status !== 'claimed' && state.hop.state !== 'ended' && state.hop.state !== 'done') send({ name: 'end' });
  }
  if (state.item.status !== 'claimed' && state.hop.state !== 'ended' && state.hop.state !== 'done') send({ name: 'end' });
  return { state, accepted };
}

test('moves.hop.generated-fault-sequences-over-two-drivers-never: generated fault sequences over two drivers never reach a double drive, debris, a zombie or a lost result [C7,#8068]', () => {
  let capped = 0, finished = 0, ended = 0, takenOver = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const { state, accepted } = simulate(seed);
    let last = 0;
    for (const { move, before, after } of accepted) {
      assert.ok(after.hop.epoch >= (before.hop?.epoch ?? 0), 'the owner epoch never goes back');
      if (move.name === 'step' || move.name === 'finish') {
        assert.deepEqual([before.hop.owner, before.hop.epoch], [move.actor, move.epoch], 'DOUBLE_DRIVE: a non-owner wrote');
        assert.equal(before.item.status, 'claimed', 'ZOMBIE: a write for an item that no longer waits');
      }
      if (move.name === 'acquire') {
        assert.equal(after.hop.epoch, before.hop.epoch + 1);
        assert.equal(before.item.status, 'claimed', 'ZOMBIE: a take for an item that no longer waits');
        if (before.hop.state === 'driven') takenOver++;
      }
      assert.ok(before.hop === null || before.hop.state === 'queued' || before.hop.state === 'driven', 'a write after the hop was over');
      last = after.hop.epoch;
    }
    assert.ok(last >= 0);
    if (state.hop.state === 'done' || state.hop.state === 'ended') assert.equal(state.hop.owner, null, 'DEBRIS: an over hop still holds an owner');
    if (state.item.status !== 'claimed') assert.ok(['ended', 'done'].includes(state.hop.state), 'DEBRIS: the item moved and the hop was left open');
    if (state.hop.state === 'ended' && state.item.status === 'claimed') {
      capped++;
      assert.equal(state.hop.attempts, HOP_ATTEMPT_CAP, 'ORPHAN: a waiting hop ended with no cap behind it');
    }
    if (state.hop.state === 'done') finished++;
    if (state.hop.state === 'ended' && state.item.status !== 'claimed') ended++;
  }
  assert.ok(finished > 0 && ended > 0 && takenOver > 0, `the generator reaches finish, item-move end and takeover (${finished}, ${ended}, ${takenOver}); capped ${capped}`);
});
