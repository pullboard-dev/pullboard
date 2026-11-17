/** @pullboard-test-loads docs/proof/lanes-and-commits-mutants.mjs */
/** @pullboard-world-pin: clauses 1 and 3 read the proof mutant lists and the repository files their edits quote, which are the files a moved line breaks. */
/** Every edit in the proof mutant lists quotes text that is in its named file on main, so a moved line cannot leave a mutant that changes nothing [C7,#8568,#8572]. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const LIST = join(ROOT, 'docs', 'proof', 'lanes-and-commits-mutants.mjs');

/**
 * The mutants a list declares, read without running its audit.
 *
 * @param {string} source - The text of a `*-mutants.mjs` file.
 * @returns {Promise<[string, string, [string, string, string][]][]>} Each mutant's row, its change in words and its edits.
 */
async function mutantsOf(source) {
  const stub = source.replace(/import \{ audit \} from '\.\/harness\.mjs';/u, 'export let LISTED; const audit = (mutants) => { LISTED = mutants; };');
  const module = await import(`data:text/javascript;base64,${Buffer.from(stub).toString('base64')}`);
  return module.LISTED;
}

/**
 * The edits whose file is missing or does not hold the text they quote.
 *
 * @param {[string, string, [string, string, string][]][]} mutants - The mutants to check.
 * @param {(file: string) => string | null} read - The text of a repository file, or null when it does not exist.
 * @returns {string[]} One line per edit that quotes nothing; empty when every edit applies.
 */
function stale(mutants, read) {
  return mutants.flatMap(([row, change, edits]) => edits.flatMap(([file, from]) => {
    const text = read(file);
    if (text === null) return [`${row} "${change}": ${file} does not exist`];
    return text.includes(from) ? [] : [`${row} "${change}": ${file} no longer holds ${JSON.stringify(from.slice(0, 60))}`];
  }));
}

const readRepo = (file) => (existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), 'utf8') : null);

test('clause 1: every edit of the lane and commit mutant list quotes text present in its named file on main [C7,#8568]', async () => {
  const mutants = await mutantsOf(readFileSync(LIST, 'utf8'));
  assert.ok(mutants.length > 20, 'the list names its mutants');
  assert.deepEqual(stale(mutants, readRepo), [], 'an edit quotes code that moved or is gone');
});

test('clause 2: an edit naming a missing file or text its file lacks is reported [C7,#8568]', async () => {
  const files = { 'a/one.js': 'const kept = 1;\n' };
  const read = (file) => files[file] ?? null;
  const listed = await mutantsOf("import { audit } from './harness.mjs';\naudit([['R1', 'fine', [['a/one.js', 'kept', 'x']], [], 'red'], ['R2', 'gone', [['a/none.js', 'kept', 'x']], [], 'red'], ['R3', 'moved', [['a/one.js', 'moved', 'x']], [], 'red']]);");
  const problems = stale(listed, read);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /a\/none\.js does not exist/u);
  assert.match(problems[1], /a\/one\.js no longer holds "moved"/u);
});

const OTHER_LISTS = ['spec', 'board', 'run', 'verification', 'shouts', 'readme'];

test('clause 3: every edit of the spec, board, run, verification, shouts and readme mutant lists quotes text present in its named file on main [C7,#8572]', async () => {
  for (const name of OTHER_LISTS) {
    const mutants = await mutantsOf(readFileSync(join(ROOT, 'docs', 'proof', `${name}-mutants.mjs`), 'utf8'));
    assert.ok(mutants.length > 5, `${name}-mutants.mjs names its mutants`);
    assert.deepEqual(stale(mutants, readRepo), [], `${name}-mutants.mjs has an edit that quotes code that moved or is gone`);
  }
});
