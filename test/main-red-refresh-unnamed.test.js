/** The post-landing refresh recompares a red main entry that names no failing case, so it becomes usable [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { refreshMainRedComparisons } from '../packages/landing/src/shell/main-red.js';

test('a red entry without named failures is refreshed alongside named ones; green and already refreshed files are not [C7]', async (t) => {
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
