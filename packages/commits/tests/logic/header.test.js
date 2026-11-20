/** fixCommitHeader never cuts an over-long header and still fixes style [C7,#12030]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixCommitHeader } from '../../src/logic/header.js';

const RULES = { maxHeader: 72, types: ['feat', 'fix', 'chore', 'docs'] };

test('commits.logic-header.long-header-untouched: clause 1: fixCommitHeader returns the message unchanged with no shortened note and no header-is-now note for an over-long header [C7,#12030]', () => {
  for (const header of [
    'chore(env): jest; speed text; builders only build; guesses become rulings',
    'chore(coordinator): one blocking wait that returns when a seat needs the coordinator',
  ]) {
    const raw = `${header}\n\nbody line\n`;
    const fixed = fixCommitHeader(raw, RULES);
    assert.equal(fixed.message, raw);
    assert.deepEqual(fixed.notes, []);
  }
});

test('commits.logic-header.style-fixes-stay: clause 2: a capitalised subject and a trailing period are still fixed in place with their notes, and a header within the limit is unchanged [C7,#12030]', () => {
  const fixed = fixCommitHeader('feat(web): Add the page. [G1]\n', RULES);
  assert.equal(fixed.message, 'feat(web): add the page [G1]\n');
  assert.equal(fixed.notes.length, 3);
  assert.match(fixed.notes[0], /lowercased the subject's first word/u);
  assert.match(fixed.notes[1], /removed the period/u);
  assert.equal(fixed.notes[2], 'header is now: feat(web): add the page [G1]');
  const clean = fixCommitHeader('feat(web): add the page [G1]\n', RULES);
  assert.equal(clean.message, 'feat(web): add the page [G1]\n');
  assert.deepEqual(clean.notes, []);
});
