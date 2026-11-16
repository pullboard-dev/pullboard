/** Tests generated from the relay outbox table: invariants every move keeps over thousands of seeded states, and metamorphic breaks that must refuse or must not matter [C7,#6729,#8328]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUTBOX_MOVES } from '../../../index.js';
import { OUTBOX_RULES } from '../../../index.js';
import { OUTBOX_STATES } from '../../../index.js';
import { OUTBOX_TABLE } from '../../../index.js';
import { runTable } from '../../../index.js';
import { seeded } from '../../../index.js';

const run = (snapshot, move) => runTable(OUTBOX_TABLE, OUTBOX_RULES, structuredClone(snapshot), structuredClone(move));

/** Which moves each state allows, in words, written here apart from the table. */
const TAIL = ['queue', 'takeBack', 'resume', 'fallback'];
const allowed = (state) => ({
  none: ['queue'],
  queued: [...TAIL, 'send', 'park'],
  sent: [...TAIL, 'send', 'acknowledge', 'park'],
  acknowledged: [...TAIL, 'send', 'acknowledge', 'park'],
  parked: [...TAIL, 'recover'],
  undone: ['apply', 'resume'],
  applied: ['remake', 'write', 'resume'],
  remade: ['write', 'resume'],
})[state];

/** The code a move earns, tried in the table's order, from the rules in words. */
function verdict(s, m) {
  const o = s.outbox, count = m.count ?? 1, tail = o.moves - o.receipted;
  const behind = o.state !== 'none' && s.board.sequence > o.baseSequence;
  const stranded = behind || ['undone', 'applied', 'remade'].includes(o.state);
  if (!OUTBOX_MOVES.includes(m.name)) return 'OUTBOX_UNKNOWN_MOVE';
  if (!OUTBOX_STATES.includes(o.state)) return 'OUTBOX_UNKNOWN_STATE';
  if (!allowed(o.state).includes(m.name)) return 'OUTBOX_ILLEGAL_MOVE';
  if (m.name === 'takeBack' && behind) return 'OUTBOX_BEHIND';
  if (m.name === 'resume' && !stranded) return 'OUTBOX_NOT_STRANDED';
  if (m.name === 'fallback' && !(Number.isSafeInteger(m.checkpoint) && m.checkpoint >= o.baseSequence)) return 'RELAY_OUTBOX';
  if (m.name === 'acknowledge' && o.receipted + count > o.sent) return 'OUTBOX_ACK_UNSENT';
  if (m.name === 'send' && o.sent + count > o.moves - o.parked) return 'OUTBOX_NOTHING_TO_SEND';
  if (m.name === 'park' && o.parked >= o.moves) return 'OUTBOX_NOTHING_TO_PARK';
  if (m.name === 'remake' && (o.remade ?? 0) >= tail) return 'OUTBOX_NOTHING_TO_REMAKE';
  if (m.name === 'write' && (o.remade ?? 0) < tail) return 'OUTBOX_TAIL_UNMADE';
  return null;
}

/** A seeded outbox: the counts nest the way a real one's do (received within sent within queued), the board sits at or past the base. */
function scenario(seed) {
  const g = seeded(seed);
  const state = g.int(40) === 0 ? 'bogus' : g.pick(OUTBOX_STATES);
  const moves = state === 'none' ? g.pick([0, 0, 1]) : g.int(7);
  const sent = g.int(moves + 1), receipted = g.int(sent + 1), parked = g.int(moves + 1);
  const baseSequence = 10 + g.int(3);
  const outbox = { state, baseSequence, moves, sent, receipted, parked, ...(g.int(4) === 0 ? {} : { remade: g.int(Math.max(moves - receipted, 0) + 2) }) };
  const board = { sequence: baseSequence + g.pick([0, 0, 0, 1, 2]) };
  const name = g.int(40) === 0 ? 'nap' : g.pick(OUTBOX_MOVES);
  const move = { name, ...(g.int(3) === 0 ? { count: g.pick([1, 2, 3]) } : {}), sequence: board.sequence, checkpoint: g.pick([baseSequence - 1, baseSequence, baseSequence + 2, undefined, 1.5]) };
  if (name === 'apply' && g.int(2) === 0) move.receipted = g.int(moves + 1);
  return { s: { outbox, board }, move };
}

const CASES = 20_000;
const results = Array.from({ length: CASES }, (_, seed) => {
  const { s, move } = scenario(seed + 1);
  return { seed: seed + 1, s, move, result: run(s, move) };
});
const ok = results.filter(c => !c.result.refused);
const only = (name) => ok.filter(c => c.move.name === name);

test('moves.outbox.rows-fire: generated: every guard and outcome row of the outbox table fires on some seeded case [C7,#8328]', () => {
  const fired = new Set(results.flatMap(c => (c.result.refused ? [c.result.refused.row] : c.result.via)));
  const rows = [...OUTBOX_TABLE.guards.map(row => row.id), ...OUTBOX_TABLE.outcomes.map(row => row.id)];
  assert.deepEqual(rows.filter(row => !fired.has(row)), []);
  assert.ok(ok.length > CASES / 10, `only ${ok.length} accepted moves`);
});

test('moves.outbox.refusal-codes: generated: each case is refused with the code the rules in words name, or accepted when they name none [C7,#8328]', () => {
  for (const c of results) assert.equal(c.result.refused?.code ?? null, verdict(c.s, c.move), `seed ${c.seed}: ${JSON.stringify([c.s, c.move])}`);
});

test('moves.outbox.refusal-writes-nothing: generated: a refusal writes nothing, and an illegal move names every legal move from its state [C7,#8328]', () => {
  for (const c of results.filter(each => each.result.refused)) {
    assert.ok(!('patch' in c.result) && !('events' in c.result), `seed ${c.seed}`);
    assert.ok(c.result.refused.message && c.result.refused.next, `seed ${c.seed}`);
    if (c.result.refused.code === 'OUTBOX_ILLEGAL_MOVE') for (const legal of allowed(c.s.outbox.state)) assert.ok(c.result.refused.next.includes(legal), `seed ${c.seed}: ${legal}`);
  }
});

test('moves.outbox.counts-and-state: generated: queue, send, acknowledge, park and recover change only the counts and state their rows name [C7,#8328]', () => {
  for (const c of ok) {
    const o = c.s.outbox, after = c.result.patch.outbox, count = c.move.count ?? 1;
    const same = (...keys) => keys.forEach(key => assert.equal(after[key], o[key], `seed ${c.seed}: ${c.move.name} changed ${key}`));
    if (c.move.name === 'queue') { assert.equal(after.moves, o.moves + 1); assert.equal(after.state, ['none', 'parked'].includes(o.state) ? 'queued' : o.state); same('sent', 'receipted', 'parked', 'baseSequence'); }
    if (c.move.name === 'send') { assert.deepEqual([after.state, after.sent], ['sent', o.sent + count], `seed ${c.seed}`); same('moves', 'receipted', 'parked'); }
    if (c.move.name === 'acknowledge') { assert.deepEqual([after.state, after.receipted], ['acknowledged', o.receipted + count], `seed ${c.seed}`); same('moves', 'sent', 'parked'); }
    if (c.move.name === 'park') { assert.deepEqual([after.state, after.parked], [o.parked + 1 === o.moves ? 'parked' : o.state, o.parked + 1], `seed ${c.seed}`); same('moves', 'sent', 'receipted'); }
    if (c.move.name === 'recover') { assert.deepEqual([after.state, after.parked], ['queued', 0], `seed ${c.seed}`); same('moves', 'sent', 'receipted'); }
  }
});

test('moves.outbox.rebuild-step: generated: a take-back, apply or remake leaves the rebuild step it names and keeps the tail it has not made again [C7,#8328]', () => {
  for (const c of only('takeBack')) assert.deepEqual([c.result.patch.outbox.state, c.result.patch.outbox.remade, c.result.patch.outbox.moves], ['undone', 0, c.s.outbox.moves], `seed ${c.seed}`);
  for (const c of only('apply')) {
    const receipted = c.move.receipted ?? c.s.outbox.receipted, after = c.result.patch.outbox;
    assert.deepEqual([after.state, after.receipted, after.remade], [c.s.outbox.moves - receipted > 0 ? 'applied' : 'remade', receipted, 0], `seed ${c.seed}`);
  }
  for (const c of only('remake')) {
    const o = c.s.outbox, after = c.result.patch.outbox, made = (o.remade ?? 0) + 1;
    assert.deepEqual([after.state, after.remade], [made >= o.moves - o.receipted ? 'remade' : 'applied', made], `seed ${c.seed}`);
  }
  for (const c of only('fallback')) assert.deepEqual([c.result.patch.outbox.state, c.result.patch.outbox.remade, c.result.patch.outbox.receipted], ['applied', 0, c.s.outbox.receipted], `seed ${c.seed}`);
});

test('moves.outbox.write-leaves-tail: generated: a write leaves exactly the unacknowledged tail on the board sequence, with nothing sent, parked or made again [C7,#8328]', () => {
  const writes = only('write');
  assert.ok(writes.length > 100, `only ${writes.length} accepted writes`);
  for (const c of writes) {
    const tail = c.s.outbox.moves - c.s.outbox.receipted;
    assert.deepEqual(c.result.patch.outbox, { state: tail > 0 ? 'queued' : 'none', baseSequence: c.s.board.sequence, moves: tail, sent: 0, receipted: 0, parked: 0, remade: 0 }, `seed ${c.seed}`);
  }
});

test('moves.outbox.event-per-move: generated: each accepted move records one outbox event of its own kind [C7,#8328]', () => {
  const kinds = { queue: 'outbox.queued', send: 'outbox.sent', acknowledge: 'outbox.acknowledged', park: 'outbox.parked', recover: 'outbox.recovered', takeBack: 'outbox.taken-back', apply: 'outbox.applied', remake: 'outbox.remade', write: 'outbox.written', resume: 'outbox.resumed', fallback: 'outbox.fell-back' };
  for (const c of ok) {
    assert.equal(c.result.events.length, 1, `seed ${c.seed}`);
    const [event] = c.result.events;
    assert.equal(event.kind, kinds[c.move.name], `seed ${c.seed}`);
    if (['send', 'acknowledge'].includes(c.move.name)) assert.equal(event.count, c.move.count ?? 1, `seed ${c.seed}`);
    if (c.move.name === 'resume') assert.equal(event.from, c.s.outbox.state, `seed ${c.seed}`);
    if (c.move.name === 'fallback') assert.equal(event.checkpoint, c.move.checkpoint, `seed ${c.seed}`);
  }
});

test('moves.outbox.deterministic: generated: the table is deterministic and reads its snapshot without changing it [C7,#8328]', () => {
  for (const c of results.slice(0, 2000)) {
    const snapshot = structuredClone(c.s), move = structuredClone(c.move);
    assert.deepEqual(runTable(OUTBOX_TABLE, OUTBOX_RULES, snapshot, move), c.result, `seed ${c.seed}`);
    assert.deepEqual([snapshot, move], [c.s, c.move], `seed ${c.seed}`);
  }
});

test('moves.outbox.count-too-high: metamorphic: ask for one more than an accepted send, acknowledge or park has left and it is refused its own code [C7,#8328]', () => {
  const over = [
    ['send', 'OUTBOX_NOTHING_TO_SEND', c => ({ ...c.move, count: c.s.outbox.moves - c.s.outbox.parked - c.s.outbox.sent + 1 })],
    ['acknowledge', 'OUTBOX_ACK_UNSENT', c => ({ ...c.move, count: c.s.outbox.sent - c.s.outbox.receipted + 1 })],
  ];
  for (const [name, code, change] of over) {
    assert.ok(only(name).length > 100, `only ${only(name).length} accepted ${name}s`);
    for (const c of only(name)) assert.equal(run(c.s, change(c)).refused?.code, code, `seed ${c.seed}`);
  }
  for (const c of only('park')) assert.equal(run({ ...c.s, outbox: { ...c.s.outbox, parked: c.s.outbox.moves } }, c.move).refused?.code, 'OUTBOX_NOTHING_TO_PARK', `seed ${c.seed}`);
});

test('moves.outbox.board-moved: metamorphic: a board that moved past the base refuses an accepted take-back OUTBOX_BEHIND, and a board at the base refuses a resume [C7,#8328]', () => {
  for (const c of only('takeBack').filter(each => each.s.outbox.state !== 'none')) {
    assert.equal(run({ ...c.s, board: { sequence: c.s.outbox.baseSequence + 1 } }, c.move).refused?.code, 'OUTBOX_BEHIND', `seed ${c.seed}`);
  }
  const resting = results.filter(c => ['queued', 'sent', 'acknowledged', 'parked'].includes(c.s.outbox.state) && c.move.name === 'resume');
  assert.ok(resting.length > 50, `only ${resting.length} resumes`);
  for (const c of resting) assert.equal(run({ ...c.s, board: { sequence: c.s.outbox.baseSequence } }, c.move).refused?.code, 'OUTBOX_NOT_STRANDED', `seed ${c.seed}`);
});

test('moves.outbox.checkpoint-old: metamorphic: a checkpoint older than the base, or not a whole number, refuses an accepted fallback RELAY_OUTBOX [C7,#8328]', () => {
  assert.ok(only('fallback').length > 100, `only ${only('fallback').length} accepted fallbacks`);
  for (const c of only('fallback')) {
    for (const checkpoint of [c.s.outbox.baseSequence - 1, c.s.outbox.baseSequence + 0.5, undefined, Number.NaN]) assert.equal(run(c.s, { ...c.move, checkpoint }).refused?.code, 'RELAY_OUTBOX', `seed ${c.seed}: ${checkpoint}`);
  }
});

test('moves.outbox.count-default: metamorphic: a count left out is the same as a count of one [C7,#8328]', () => {
  for (const c of ok.filter(each => ['send', 'acknowledge'].includes(each.move.name) && each.move.count === undefined)) {
    assert.deepEqual(run(c.s, { ...c.move, count: 1 }), c.result, `seed ${c.seed}`);
  }
});

test('moves.outbox.shift-invariant: metamorphic: shifting the base, the board and the checkpoint by the same amount changes no outcome, only the sequence it writes [C7,#8328]', () => {
  const shift = ({ s, move }, by) => ({ s: { outbox: { ...s.outbox, baseSequence: s.outbox.baseSequence + by }, board: { sequence: s.board.sequence + by } }, move: { ...move, sequence: move.sequence + by, checkpoint: move.checkpoint + by } });
  for (const c of results.slice(0, 5000)) {
    for (const by of [-9, 1, 1000]) {
      const moved = shift(c, by), again = run(moved.s, moved.move);
      assert.deepEqual(again.refused?.row ?? again.via, c.result.refused?.row ?? c.result.via, `seed ${c.seed}: a shift of ${by} changed the outcome`);
      if (c.move.name === 'write' && !c.result.refused) assert.equal(again.patch.outbox.baseSequence, c.result.patch.outbox.baseSequence + by, `seed ${c.seed}`);
    }
  }
});

test('moves.outbox.resumes-settle: metamorphic: from any stranded state at most three resumes settle the outbox on the board with nothing receipted left in it [C7,#8328]', () => {
  const stranded = results.filter(c => c.move.name === 'resume' && !c.result.refused);
  assert.ok(stranded.length > 200, `only ${stranded.length} stranded outboxes`);
  for (const c of stranded) {
    let s = c.s;
    for (let step = 0; step < 3 && !['none', 'queued'].includes(s.outbox.state) || step === 0; step++) {
      const answer = run(s, { name: 'resume' });
      assert.ok(!answer.refused, `seed ${c.seed}: resume refused from ${s.outbox.state}`);
      s = { ...s, ...answer.patch };
    }
    assert.ok(['none', 'queued'].includes(s.outbox.state), `seed ${c.seed}: still ${s.outbox.state}`);
    assert.deepEqual([s.outbox.baseSequence, s.outbox.receipted, s.outbox.sent, s.outbox.parked], [s.board.sequence, 0, 0, 0], `seed ${c.seed}`);
    assert.equal(s.outbox.moves, c.s.outbox.moves - c.s.outbox.receipted, `seed ${c.seed}: the unacknowledged tail was lost or invented`);
  }
});

test('moves.outbox.rebuild-keeps-tail: metamorphic: a whole rebuild by take-back, apply, remakes and write keeps exactly the unacknowledged tail [C7,#8328]', () => {
  const resting = results.filter(c => ['queued', 'sent', 'acknowledged'].includes(c.s.outbox.state) && c.s.board.sequence === c.s.outbox.baseSequence);
  assert.ok(resting.length > 500, `only ${resting.length} resting outboxes`);
  for (const c of resting) {
    let s = { ...c.s, outbox: { ...c.s.outbox, remade: 0 } };
    const step = (move) => { const answer = run(s, move); assert.ok(!answer.refused, `seed ${c.seed}: ${move.name} from ${s.outbox.state}: ${answer.refused?.code}`); s = { ...s, ...answer.patch }; };
    step({ name: 'takeBack' });
    step({ name: 'apply', sequence: s.board.sequence + 2, receipted: s.outbox.receipted });
    s = { ...s, board: { sequence: s.board.sequence + 2 } };
    while (s.outbox.state === 'applied') step({ name: 'remake' });
    step({ name: 'write' });
    assert.equal(s.outbox.moves, c.s.outbox.moves - c.s.outbox.receipted, `seed ${c.seed}`);
    assert.equal(s.outbox.state, s.outbox.moves > 0 ? 'queued' : 'none', `seed ${c.seed}`);
  }
});
