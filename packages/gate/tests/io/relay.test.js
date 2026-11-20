/** The relay boundary check follows the GitHub client into apps/relay without opening a new fetch path [C7]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { relayBoundaryProblems } from '../../src/io/relay.js';
import { styleSources } from '../../../codemap/index.js';
import { repoPath } from '../../../kernel/light.js';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const GITHUB_FETCH = "      try { response = await fetch(url, { method: form || json ? 'POST' : 'GET', headers, body, redirect: 'manual', signal }); }";

test('gate.relay.moved-fetch-allowed: the moved GitHub client fetch is allowed at apps/relay/src/io/github.js [C7]', () => {
  for (const file of ['apps/relay/src/io/github.js']) {
    assert.deepEqual(relayBoundaryProblems([{ file, source: `export async function call(url) {\n${GITHUB_FETCH}\n}` }]), [], file);
    const stray = relayBoundaryProblems([{ file, source: `${GITHUB_FETCH}\nfetch('/relay');` }]);
    assert.deepEqual(stray.map(row => [row.file, row.line]), [[file, 2]], 'only the one audited call is allowed there');
  }
  assert.equal(relayBoundaryProblems([{ file: 'apps/relay/src/shell/other.js', source: GITHUB_FETCH }]).length, 1, 'no other apps/relay file inherits the exception');
});

test('gate.relay.boundary-passes: the relay boundary check passes on this tree [C7]', () => {
  const relay = readdirSync(join(ROOT, 'apps/relay'), { withFileTypes: true }).filter(entry => entry.isFile() && /\.[cm]?js$/u.test(entry.name))
    .map(entry => ({ file: `apps/relay/${entry.name}`, source: readFileSync(repoPath(ROOT, `apps/relay/${entry.name}`), 'utf8') }));
  assert.deepEqual(relayBoundaryProblems([...styleSources(ROOT), ...relay]), []);
});

/** The source gate rejects a new direct network call while ignoring comments and fixture strings. */
test('gate.relay.lint-refuses-stray-fetch: relay lint refuses a stray direct fetch [C7]', () => {
  const rows = relayBoundaryProblems([{ file: 'src/stray-relay.js', source: 'export async function read(url) { return fetch(url); }' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, 'src/stray-relay.js');
  assert.equal(relayBoundaryProblems([{ file: 'src/stray.js', source: "globalThis['fetch']('/relay')" }]).length, 1);
  assert.equal(relayBoundaryProblems([{ file: 'src/stray.js', source: 'const send = globalThis.fetch; send(url);' }]).length, 1);
  assert.equal(relayBoundaryProblems([{ file: 'src/stray.js', source: 'const { fetch } = globalThis; fetch(url);' }]).length, 2);
  assert.equal(relayBoundaryProblems([{ file: 'apps/relay/src/io/github.js', source: "fetch(url, { method: form || json }); fetch('/relay');" }]).length, 1);
  assert.deepEqual(relayBoundaryProblems([{ file: 'src/fixture.js', source: 'const example = "fetch(url)"; // fetch(url)' }]), []);
});
