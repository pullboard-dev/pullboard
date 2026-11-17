/** The table engine: first failing guard refuses, outcomes patch, gaps refuse [C7,#8064]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineRules } from '../../../index.js';
import { runTable } from '../../../index.js';

const RULES = defineRules({
  claimed: { says: 'the item is claimed', holds: s => s.item.status === 'claimed' },
  mine: { says: 'the caller holds the claim', holds: (s, m) => s.item.owner === m.actor },
  holder: { says: 'a claimed item is held by the caller', reads: ['claimed', 'mine'], holds: (_s, _m, fact) => fact('claimed') && fact('mine') },
  noted: { says: 'the move carries a note', holds: (_s, m) => Boolean(m.note) },
  reopened: { says: 'the item is open after the move', holds: s => s.item.status === 'open' },
});

const TABLE = {
  name: 'release',
  guards: [
    { id: 'claimed', requires: 'claimed', code: 'NOT_CLAIMED', message: (s) => `item ${s.item.id} is ${s.item.status}`, next: 'claim it first' },
    { id: 'holder', requires: 'holder', code: 'NOT_YOURS', message: 'another seat holds it', next: 'shout its holder' },
  ],
  outcomes: [
    { id: 'noted', when: 'noted', patch: () => ({ status: 'open', owner: null }), events: (_s, m) => [{ kind: 'release', note: m.note }] },
    { id: 'plain', when: 'mine', patch: () => ({ status: 'open', owner: null }), events: () => [{ kind: 'release' }] },
  ],
  followups: [
    { id: 'tally', when: 'reopened', apply: ({ before, after }) => ({ patch: { was: before.item.status, now: after.item.status }, events: [{ kind: 'tally' }] }) },
  ],
};
const snap = (over = {}) => ({ item: { id: 7, status: 'claimed', owner: 'a', ...over }, history: [] });

test('moves.run.runtable-refuses-with-the-first-failing-guard: runTable refuses with the first failing guard: code, message, next, row and fact trace [C7,#8064]', () => {
  const answer = runTable(TABLE, RULES, snap({ status: 'open' }), { name: 'release', actor: 'a' });
  assert.deepEqual(answer, { refused: { code: 'NOT_CLAIMED', message: 'item 7 is open', next: 'claim it first', row: 'claimed', fact: 'claimed', trace: [{ fact: 'claimed', holds: false }] } });
  const second = runTable(TABLE, RULES, snap(), { name: 'release', actor: 'b' });
  assert.equal(second.refused.code, 'NOT_YOURS');
  assert.equal(second.refused.row, 'holder');
  assert.deepEqual(second.refused.trace.map(entry => entry.fact), ['claimed', 'mine', 'holder']);
});

test('moves.run.runtable-returns-the-first-matching-outcome-then: runTable returns the first matching outcome, then follow-ups see the item before and after [C7,#8064]', () => {
  const both = runTable(TABLE, RULES, snap(), { name: 'release', actor: 'a', note: 'done' });
  assert.deepEqual(both, { patch: { status: 'open', owner: null, was: 'claimed', now: 'open' }, events: [{ kind: 'release', note: 'done' }, { kind: 'tally' }], via: ['noted', 'tally'] });
  const plain = runTable(TABLE, RULES, snap(), { name: 'release', actor: 'a' });
  assert.deepEqual(plain.via, ['plain', 'tally']);
  assert.equal(plain.patch.was, 'claimed');
});

test('moves.run.runtable-never-writes-to-the-snapshot-it: runTable never writes to the snapshot it reads [C7,#8064]', () => {
  const snapshot = snap();
  runTable(TABLE, RULES, snapshot, { name: 'release', actor: 'a' });
  assert.equal(snapshot.item.status, 'claimed');
  assert.equal(Object.isFrozen(snapshot.item), true);
});

test('moves.run.a-move-no-outcome-matches-is-a: a move no outcome matches is a TABLE_GAP refusal naming the table and move, not a throw [C7,#8064]', () => {
  const gap = runTable({ ...TABLE, outcomes: TABLE.outcomes.slice(0, 1) }, RULES, snap(), { name: 'release', actor: 'a' });
  assert.equal(gap.refused.code, 'TABLE_GAP');
  assert.match(gap.refused.message, /table release/);
  assert.match(gap.refused.message, /move release/);
  assert.equal(gap.refused.row, null);
});

const SPRINT_ONLY = { id: 'sprint-note', requires: 'noted', code: 'NOTE_NEEDED', message: 'a sprint release needs a note', next: 'add --note', paces: ['sprint'], always: 'A8' };
const PACED = { ...TABLE, guards: [...TABLE.guards, SPRINT_ONLY] };

test('moves.run.a-guard-marked-for-sprint-only-is: clause 1: a guard marked for sprint only is skipped for a steady snapshot, and a snapshot with no pace runs as steady [M1]', () => {
  const steady = runTable(PACED, RULES, { ...snap(), pace: 'steady' }, { name: 'release', actor: 'a' });
  assert.deepEqual(steady.via, ['plain', 'tally']);
  const unpaced = runTable(PACED, RULES, snap(), { name: 'release', actor: 'a' });
  assert.deepEqual(unpaced, runTable(TABLE, RULES, snap(), { name: 'release', actor: 'a' }));
  const offStrict = runTable({ ...TABLE, outcomes: [{ ...TABLE.outcomes[1], id: 'sprint-plain', paces: ['sprint'] }, TABLE.outcomes[1]] }, RULES, snap(), { name: 'release', actor: 'a' });
  assert.deepEqual(offStrict.via, ['plain', 'tally'], 'an outcome outside the pace is skipped too');
});

test('moves.run.that-sprint-only-guard-refuses-for-a: clause 2: that sprint-only guard refuses for a sprint snapshot [M1]', () => {
  const sprint = runTable(PACED, RULES, { ...snap(), pace: 'sprint' }, { name: 'release', actor: 'a' });
  assert.equal(sprint.refused.code, 'NOTE_NEEDED');
  assert.equal(sprint.refused.row, 'sprint-note');
  const noted = runTable(PACED, RULES, { ...snap(), pace: 'sprint' }, { name: 'release', actor: 'a', note: 'done' });
  assert.deepEqual(noted.via, ['noted', 'tally']);
});
