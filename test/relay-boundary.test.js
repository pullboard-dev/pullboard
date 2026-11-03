/** The relay boundary check follows the GitHub client into apps/relay without opening a new fetch path [C7]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { relayBoundaryProblems } from '../bin/checks/relay-boundary.js';
import { styleSources } from '../packages/codemap/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GITHUB_FETCH = "      try { response = await fetch(url, { method: form || json ? 'POST' : 'GET', headers, body, redirect: 'manual', signal }); }";

test('the moved GitHub client fetch is allowed at apps/relay/src/shell/github.js and the old path [C7]', () => {
  for (const file of ['apps/relay/src/shell/github.js', 'relay/github.js']) {
    assert.deepEqual(relayBoundaryProblems([{ file, source: `export async function call(url) {\n${GITHUB_FETCH}\n}` }]), [], file);
    const stray = relayBoundaryProblems([{ file, source: `${GITHUB_FETCH}\nfetch('/relay');` }]);
    assert.deepEqual(stray.map(row => [row.file, row.line]), [[file, 2]], 'only the one audited call is allowed there');
  }
  assert.equal(relayBoundaryProblems([{ file: 'apps/relay/src/shell/other.js', source: GITHUB_FETCH }]).length, 1, 'no other apps/relay file inherits the exception');
});

test('the relay boundary check passes on this tree [C7]', () => {
  const relay = readdirSync(join(ROOT, 'relay'), { withFileTypes: true }).filter(entry => entry.isFile() && /\.[cm]?js$/u.test(entry.name))
    .map(entry => ({ file: `relay/${entry.name}`, source: readFileSync(join(ROOT, 'relay', entry.name), 'utf8') }));
  assert.deepEqual(relayBoundaryProblems([...styleSources(ROOT), ...relay]), []);
});
