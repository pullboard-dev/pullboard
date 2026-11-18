/** The post-landing refresh recompares a red main entry that names no failing case, so it becomes usable [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { refreshMainRedComparisons } from '../../../../../src/io/main/red.js';

test('landing.unnamed.a-red-entry-without-named-failures: a red entry without named failures is refreshed alongside named ones; green and already refreshed files are not [C7]', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-refresh-unnamed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  mkdirSync(join(root, '.git', 'pullboard'), { recursive: true });
  const previous = 'a'.repeat(40), published = 'b'.repeat(40);
  const named = { result: 'red', signatureVersion: 4, failures: [{ file: 'test/named.test.js', name: 'a case', signature: 'f'.repeat(64), firstError: 'x', ran: 'test/named.test.js' }] };
  writeFileSync(join(root, '.git', 'pullboard', 'main-red.json'), JSON.stringify({ version: 2, entries: {
    [previous]: { 'test/named.test.js': named, 'test/unnamed.test.js': { result: 'red', failures: [] }, 'test/green.test.js': { result: 'green' },
      'test/done.test.js': { result: 'red', failures: [] } },
    [published]: { 'test/done.test.js': { result: 'red', signatureVersion: 4, failures: [{ file: 'test/done.test.js', name: 'x', signature: 'e'.repeat(64), firstError: 'x', ran: 'test/done.test.js' }] } },
  } }), { mode: 0o600 }); // the cache is private to its owner; other modes read as empty
  const compared = [];
  const results = await refreshMainRedComparisons(root, previous, published, () => {}, async (_root, profile, _wait, _out, options) => {
    compared.push([profile.tests[0].file, options.commit, options.fresh, options.detailed]);
    return { main: published, files: [] };
  });
  assert.deepEqual(compared.map(row => row[0]).sort(), ['test/named.test.js', 'test/unnamed.test.js']);
  assert.ok(compared.every(row => row[1] === published && row[2] === true && row[3] === true), 'each refresh is fresh and detailed at the published main');
  assert.equal(results.length, 2);
});

test('landing.unnamed.a-red-file-cached-under-a: a red file cached under a recent generation is refreshed when the prior main holds nothing; older generations and files past the limit wait [C7]', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-refresh-generations-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  mkdirSync(join(root, '.git', 'pullboard'), { recursive: true });
  const previous = 'a'.repeat(40), published = 'b'.repeat(40);
  const red = { result: 'red', failures: [] };
  // Insertion order is recency: the oldest generation first, then eight newer ones, then a content record, then the prior main.
  const entries = { ['0'.repeat(40)]: { 'test/too-old.test.js': red } };
  for (let index = 1; index <= 8; index += 1) entries[String(index).repeat(40)] = { [`test/gen-${index}.test.js`]: red };
  entries['c'.repeat(64)] = { 'test/content.test.js': red };
  entries[previous] = {};
  writeFileSync(join(root, '.git', 'pullboard', 'main-red.json'), JSON.stringify({ version: 2, entries }), { mode: 0o600 });
  const compared = [];
  const compare = async (_root, profile) => { compared.push(profile.tests[0].file); return { main: published, files: [] }; };
  await refreshMainRedComparisons(root, previous, published, () => {}, compare);
  assert.deepEqual(compared.sort(), Array.from({ length: 8 }, (_, index) => `test/gen-${index + 1}.test.js`), 'the eight newest commit generations, not the ninth and not a content record');
  compared.length = 0;
  await refreshMainRedComparisons(root, previous, published, () => {}, compare, { generations: 8, limit: 3 });
  assert.equal(compared.length, 3, 'the limit caps one refresh');
  assert.deepEqual(compared, ['test/gen-8.test.js', 'test/gen-7.test.js', 'test/gen-6.test.js'], 'newest generations first');
});
