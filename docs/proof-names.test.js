/** @pullboard-world-pin: clause 1 reads the mutant lists and the test files they name, which are the repository files a moved test breaks. */
/** Every test a proof mutant list names exists and carries the named title, so a moved or renamed test cannot leave a mutant judged by nothing [P4,C7]. */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const PROOF = join(ROOT, 'docs', 'proof');
/** A `['<file>.test.js', '<title>']` pair as the mutant lists write it, in single or double quotes. */
const PAIR = /\[\s*'([^']+\.test\.js)',\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/gu;
const unescape = (text) => text.replace(/\\(.)/gu, '$1');

/**
 * The [file, title] pairs a mutant list's source names.
 *
 * @param {string} source - The text of a `*-mutants.mjs` file.
 * @returns {[string, string][]} Each named test file with the title part it is judged by.
 */
function namedTests(source) {
  return [...source.matchAll(PAIR)].map((match) => [match[1], unescape(match[2] ?? match[3])]);
}

/**
 * The problems with a list of named tests: a file that is missing, or a title its file does not hold.
 *
 * @param {[string, string][]} pairs - Test files with titles.
 * @param {(file: string) => string | null} read - The text of a repository file, or null when it does not exist.
 * @returns {string[]} One line per problem; empty when every pair resolves.
 */
function unresolved(pairs, read) {
  return pairs.flatMap(([file, title]) => {
    const text = read(file);
    if (text === null) return [`${file} does not exist (named for "${title}")`];
    return unescape(text).includes(title) ? [] : [`${file} holds no test titled "${title}"`];
  });
}

const readRepo = (file) => (existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), 'utf8') : null);

test('clause 1: every test file and title the proof mutant lists name exists [P4,C7]', () => {
  const lists = readdirSync(PROOF).filter((name) => name.endsWith('-mutants.mjs'));
  assert.ok(lists.length > 0, 'no mutant lists found under docs/proof');
  for (const list of lists) {
    const pairs = namedTests(readFileSync(join(PROOF, list), 'utf8'));
    assert.ok(pairs.length > 0, `${list} names no test`);
    assert.deepEqual(unresolved(pairs, readRepo), [], `${list} names a test that is not there`);
  }
});

test('clause 2: an entry naming a missing file or a title not in its file is reported [P4,C7]', () => {
  const files = { 'a/one.test.js': "test('the real title [X1]', () => {});\ntest('it\\'s quoted', () => {});" };
  const read = (file) => files[file] ?? null;
  const source = `const A = ['a/one.test.js', 'the real title'];\nconst B = ['a/one.test.js', "it's quoted"];\n`;
  assert.deepEqual(unresolved(namedTests(source), read), []);
  const missing = unresolved(namedTests("const C = ['a/gone.test.js', 'the real title'];"), read);
  assert.match(missing.join(), /a\/gone\.test\.js does not exist/u);
  const renamed = unresolved(namedTests("const D = ['a/one.test.js', 'a title nobody wrote'];"), read);
  assert.match(renamed.join(), /holds no test titled "a title nobody wrote"/u);
});
