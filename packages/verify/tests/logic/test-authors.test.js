/** The author record of a named test file: which seat and family wrote it, read back newest first [C7,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentHash } from '../../index.js';
import { testAuthorNotes } from '../../index.js';
import { testAuthors } from '../../index.js';

const item = { item_id: 9, item_criterion: '1. a/one.test.js and a/two.test.js pass [test]. 2. b/x.txt exists.' };
const main = { 'a/two.test.js': 'two' };
const head = { 'a/one.test.js': 'one', 'a/two.test.js': 'two' };
const source = (over = {}) => ({ atHead: path => head[path] ?? null, atMain: path => main[path] ?? null, seat: 'core-1', family: 'Family Alpha', ...over });

test('verify.author.recorded: clause 1: a named test file the head adds is recorded with its seat and family, an unchanged one is not [C7,V4]', () => {
  assert.deepEqual(testAuthorNotes(item, [], source()), [`test author a/one.test.js: seat core-1, family Family Alpha, sha256 ${contentHash('one')}`]);
});

test('verify.author.not-twice: clause 1: a file already recorded at this content is not recorded twice, and a changed one is [C7,V4]', () => {
  const [text] = testAuthorNotes(item, [], source());
  const thread = [{ type: 'fact', kind: 'note', id: 'f1', text }];
  assert.deepEqual(testAuthorNotes(item, thread, source()), []);
  assert.equal(testAuthorNotes(item, thread, source({ atHead: path => (path === 'a/one.test.js' ? 'one!' : head[path] ?? null), seat: 'core-2', family: null }))[0].includes('seat core-2, family unknown'), true);
});

test('verify.author.newest: clause 2: the newest author record per file is the one show prints [C7,V4]', () => {
  const [first] = testAuthorNotes(item, [], source());
  const [second] = testAuthorNotes(item, [], source({ atHead: path => (path === 'a/one.test.js' ? 'one!' : null), seat: 'core-2', family: 'Family Beta' }));
  const authors = testAuthors([{ type: 'fact', kind: 'note', id: 'f1', text: first }, { type: 'fact', kind: 'note', id: 'f2', text: second }, { type: 'fact', kind: 'note', id: 'f3', text: 'unrelated' }]);
  assert.equal(authors['a/one.test.js'].seat, 'core-2');
  assert.equal(authors['a/one.test.js'].family, 'Family Beta');
});
