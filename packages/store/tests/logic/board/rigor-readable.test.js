/** A Rigor row's encoded source reads as one line, and the stored text still parses [D1,S1]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { automaticRigorSource } from '../../../index.js';
import { automaticSourceFromText } from '../../../index.js';
import { readableRigorText } from '../../../index.js';

const COMMIT = 'a'.repeat(40);
const cause = { key: 'test:x.test.js::fails', items: [{ id: 12, commits: [COMMIT] }, { id: 30, commits: [] }], occurrences: 2, neverAgain: false };
const stored = `Review how to prevent repeats. Source: ${automaticRigorSource(cause, [5, 6])}`;

test('the trailing rigor-auto source becomes one readable line naming key, count and items [D1]', () => {
  const shown = readableRigorText(stored);
  assert.equal(shown, 'Review how to prevent repeats. Source: Rigor evidence for test:x.test.js::fails, 2 occurrences across #12, #30.');
  assert.equal(shown.includes('%7B'), false);
});

test('other text is returned unchanged [D1]', () => {
  for (const text of ['A plain row.', 'A row. Source: rigor-auto:%7Bnot-valid', 'Source: elsewhere', '']) assert.equal(readableRigorText(text), text);
  assert.equal(readableRigorText(undefined), undefined);
});

test('the stored text is untouched and still parses with the existing reader [S1]', () => {
  const before = stored;
  readableRigorText(stored);
  assert.equal(stored, before);
  assert.ok(automaticSourceFromText(stored));
});
