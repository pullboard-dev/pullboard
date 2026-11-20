/** show's thread lines come from one pure function, with the exact text the full path printed before [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { threadLines } from '../../../src/logic/show/thread.js';

const nameOf = by => `name-of-${by}`;
const THREAD = [
  { type: 'fact', kind: 'note', id: 'f1', at: '2026-11-18T10:00', by: 'a1', text: 'clause 1: green', ref: { path: 'src/x.js', start: 3, end: 5, commit: 'abc123' } },
  { type: 'fact', kind: 'note', id: 'f2', at: '2026-11-18T10:01', by: 'a2', text: 'agreed', answers: 'f1', ref: { path: 'src/y.js', start: 7, end: 7, commit: 'def456' } },
  { type: 'event', kind: 'add', at: '2026-11-18T10:02', by: 'a1', detail: { reason: 'too big', note: 'split it', previousTitle: 'old title' } },
  { type: 'event', kind: 'proof-run', at: '2026-11-18T10:03', by: 'a1', detail: { note: 'skipped' } },
];

test('cli.logic-show-thread.thread-lines-match-the-recorded-text: clause 1: threadLines returns the thread header and one line per entry, a fact with its ref line and any other entry with its commit, title change, reason and note, skipping proof-run entries [C7]', () => {
  assert.deepEqual(threadLines(THREAD, nameOf), [
    'thread:',
    '  2026-11-18T10:00  name-of-a1  fact note f1: clause 1: green',
    '    ref: src/x.js:3-5@abc123',
    '  2026-11-18T10:01  name-of-a2  fact note f2 (answers f1): agreed',
    '    ref: src/y.js:7@def456',
    '  2026-11-18T10:02  name-of-a1  add (title was: old title): too big: split it',
  ]);
  assert.deepEqual(threadLines([], nameOf), ['thread:'], 'an empty thread prints only its header');
  const escalate = [{ type: 'event', kind: 'escalate', at: 't', by: 'a1', detail: { commit: 'c1', note: 'line one\nline two' } }];
  assert.equal(threadLines(escalate, nameOf, note => note.split('\n')[0])[1], '  t  name-of-a1  escalate at c1: line one', 'an escalate note is cut by the caller’s first-line rule');
});
