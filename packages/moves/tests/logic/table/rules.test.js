/** The derived-facts rules layer: named facts over a frozen snapshot, traced, refused when badly defined [C7,#8063]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineRules } from '../../../index.js';
import { deriveFact } from '../../../index.js';

/** A small lifecycle in the U152 shape: unproven, blocked, ready. */
function lifecycle() {
  return defineRules({
    landed: { says: 'the item it waits on has landed', holds: (snapshot) => snapshot.after.every(id => snapshot.landed.includes(id)) },
    proven: { says: 'every clause has a proof', holds: (snapshot) => snapshot.clauses.every(clause => snapshot.proofs.includes(clause)) },
    blocked: { says: 'it waits on an item that has not landed', reads: ['landed'], holds: (_snapshot, _move, fact) => !fact('landed') },
    ready: { says: 'proven and not blocked', reads: ['proven', 'blocked'], holds: (_snapshot, _move, fact) => fact('proven') && !fact('blocked') },
  });
}

const SNAPSHOT = () => ({ after: [6928], landed: [6928], clauses: [1, 2], proofs: [1, 2] });

test('deriveFact answers a fact and traces every fact it read, the asked fact last [C7,#8063]', () => {
  const answer = deriveFact(lifecycle(), 'ready', SNAPSHOT());
  assert.deepEqual(answer, {
    fact: 'ready',
    holds: true,
    trace: [{ fact: 'proven', holds: true }, { fact: 'landed', holds: true }, { fact: 'blocked', holds: false }, { fact: 'ready', holds: true }],
  });
  const blocked = deriveFact(lifecycle(), 'ready', { ...SNAPSHOT(), landed: [] });
  assert.equal(blocked.holds, false);
  assert.deepEqual(blocked.trace.at(-2), { fact: 'blocked', holds: true });
});

test('a fact read by two rules is derived once per call [C7,#8063]', () => {
  let calls = 0;
  const rules = defineRules({
    base: { says: 'base', holds: () => { calls += 1; return true; } },
    left: { says: 'left', reads: ['base'], holds: (_s, _m, fact) => fact('base') },
    both: { says: 'both', reads: ['left', 'base'], holds: (_s, _m, fact) => fact('left') && fact('base') },
  });
  assert.deepEqual(deriveFact(rules, 'both', {}).trace.map(entry => entry.fact), ['base', 'left', 'both']);
  assert.equal(calls, 1);
});

test('the moves front door exports defineRules and deriveFact [C7,#8063]', async () => {
  const door = await import('../../../index.js');
  assert.equal(typeof door.defineRules, 'function');
  assert.equal(typeof door.deriveFact, 'function');
});

test('defineRules refuses a rule that reads an undefined fact, when the rules are defined [C7,#8063]', () => {
  assert.throws(() => defineRules({ ready: { says: 'ready', reads: ['proven'], holds: () => true } }),
    error => error.code === 'RULE_UNDEFINED' && /ready reads proven/.test(error.message) && /define proven/.test(error.next));
});

test('defineRules refuses a cycle, naming it, when the rules are defined [C7,#8063]', () => {
  assert.throws(() => defineRules({
    a: { says: 'a', reads: ['b'], holds: () => true },
    b: { says: 'b', reads: ['c'], holds: () => true },
    c: { says: 'c', reads: ['a'], holds: () => true },
  }), error => error.code === 'RULE_CYCLE' && /a -> b -> c -> a/.test(error.message));
  assert.throws(() => defineRules({ self: { says: 'self', reads: ['self'], holds: () => true } }), error => error.code === 'RULE_CYCLE');
});

test('a rule set that defines cleanly is never refused at use for its shape [C7,#8063]', () => {
  const rules = lifecycle();
  for (const name of Object.keys(rules)) assert.equal(typeof deriveFact(rules, name, SNAPSHOT()).holds, 'boolean');
  assert.throws(() => defineRules({ shapeless: { reads: [] } }), error => error.code === 'RULE_SHAPE');
});

test('a rule that reads a fact it did not declare is refused, so declared reads stay the whole graph [C7,#8063]', () => {
  const rules = defineRules({
    proven: { says: 'proven', holds: () => true },
    sneaky: { says: 'sneaky', holds: (_s, _m, fact) => fact('proven') },
  });
  assert.throws(() => deriveFact(rules, 'sneaky', {}), error => error.code === 'RULE_UNDECLARED_READ');
  assert.throws(() => deriveFact(rules, 'missing', {}), error => error.code === 'RULE_UNDEFINED');
});

test('deriving leaves the snapshot unchanged [C7,#8063]', () => {
  const snapshot = SNAPSHOT();
  const before = structuredClone(snapshot);
  deriveFact(lifecycle(), 'ready', snapshot, { at: 1 });
  assert.deepEqual(snapshot, before);
  const writer = defineRules({ writes: { says: 'writes', holds: (s) => { s.landed.push(1); return true; } } });
  const guarded = SNAPSHOT();
  assert.throws(() => deriveFact(writer, 'writes', guarded), TypeError);
  assert.deepEqual(guarded, SNAPSHOT());
});

test('deriving gives the same answer twice for the same snapshot and move [C7,#8063]', () => {
  const rules = lifecycle();
  const snapshot = SNAPSHOT();
  assert.deepEqual(deriveFact(rules, 'ready', snapshot, { at: 1 }), deriveFact(rules, 'ready', snapshot, { at: 1 }));
  const unready = { ...SNAPSHOT(), proofs: [1] };
  assert.deepEqual(deriveFact(rules, 'ready', unready), deriveFact(rules, 'ready', unready));
  assert.throws(() => deriveFact(defineRules({ bad: { says: 'bad', holds: () => 1 } }), 'bad', {}), error => error.code === 'RULE_NOT_BOOLEAN');
});
