/** The needs-judgement note and its chip on a roadmap row [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgementNote } from '../../src/io/held.js';
import { milestoneRowHtml } from '../../src/io/roadmap/render.js';

const source = { needsJudgement: [{ id: 7, reason: 'RED_TWICE', refusalText: 'the gate refused twice', attempts: 3 }] };

test('view.held.judgement-note: clause 1: a listed item reads its reason and attempts, any other item or board reads null [C7]', () => {
  const note = judgementNote({ id: 7 }, source);
  assert.match(note, /^needs a judgement: RED_TWICE, 3 attempts/u);
  assert.match(note, /the gate refused twice/u);
  assert.equal(judgementNote({ id: 8 }, source), null);
  assert.equal(judgementNote({ id: 7 }, {}), null);
  assert.equal(judgementNote({ id: 7 }, { needsJudgement: [] }), null);
});

test('view.held.judgement-chip-on-roadmap: clause 2: the roadmap row shows the chip with its note on hover for a listed item and is unchanged for others [C7]', () => {
  const row = { label: '#7', why: 'Seven', stage: 'open', state: 'open', position: 1 };
  const plain = milestoneRowHtml(row);
  const note = judgementNote({ id: 7 }, source);
  const marked = milestoneRowHtml({ ...row, judgement: note });
  assert.match(marked, /<span class="chip warn judgement" title="needs a judgement: RED_TWICE, 3 attempts/u);
  assert.equal(milestoneRowHtml({ ...row, judgement: null }), plain);
  assert.doesNotMatch(plain, /judgement/u);
  assert.equal(marked.replace(/<span class="chip warn judgement"[^>]*>judgement<\/span>/u, ''), plain);
  // The production caller (cockpit roadmap) always supplies stateChipHtml; the chip must still show beside it.
  const stage = { stateChipHtml: '<span class="chip busy">Building</span>' };
  const staged = milestoneRowHtml({ ...row, judgement: note }, stage);
  assert.match(staged, /<span class="chip busy">Building<\/span><span class="chip warn judgement" title="needs a judgement: RED_TWICE/u);
  assert.equal(milestoneRowHtml({ ...row, judgement: null }, stage), milestoneRowHtml(row, stage));
});
