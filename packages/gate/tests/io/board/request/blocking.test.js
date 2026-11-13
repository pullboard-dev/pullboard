/** The board API request path never runs a synchronous child process outside a shrinking known set [C7]. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { styleSources } from '../../../../../codemap/index.js';
import { apiRequestIoProblems } from '../../../../src/io/board/request.js';
import { HTTP_SERVERS } from '../../../../src/io/board/request.js';
import { KNOWN_REQUEST_BLOCKERS } from '../../../../src/io/board/request.js';

const root = fileURLToPath(new URL('../../../../../..', import.meta.url));
const sources = styleSources(root);

test('clause 1: the tree has no synchronous child process reachable from an API request beyond the listed known set [C7]', () => {
  assert.deepEqual(apiRequestIoProblems(sources).map(row => `${row.file}:${row.line} ${row.call} (${row.owner})`), []);
});

test('clause 1: every known violation names why, and the seeded set includes mainReceipts and the cached-candidate git log [C7]', () => {
  for (const [owner, why] of Object.entries(KNOWN_REQUEST_BLOCKERS)) assert.ok(why.length > 10, owner);
  assert.ok('packages/landing/src/io/main/red/receipt.js#treeOf' in KNOWN_REQUEST_BLOCKERS);
  assert.ok('packages/landing/src/io/main/red/receipt.js#unchangedDescendants' in KNOWN_REQUEST_BLOCKERS);
});

test('clause 1: a new spawnSync, execSync or gitSpawnSync call reached from a handler outside the list fails [C7]', () => {
  const calls = { spawn: "import { spawnSync } from 'node:child_process';\nexport function helper() { return spawnSync('ls'); }",
    exec: "import { execSync } from 'node:child_process';\nexport function helper() { return execSync('ls'); }",
    git: "import { gitSpawnSync } from '../../../git/index.js';\nexport function helper() { return gitSpawnSync(['status']); }" };
  for (const [kind, text] of Object.entries(calls)) {
    const injected = [...sources.filter(row => row.file !== 'packages/api/src/io/main.js'), ...[sources.find(row => row.file === 'packages/api/src/io/main.js')]
      .map(row => ({ ...row, source: row.source + "\nimport { helper } from './added.js';\nexport function addedHandler() { return helper(); }\n" })),
    { file: 'packages/api/src/io/added.js', source: text }];
    const rows = apiRequestIoProblems(injected).filter(row => row.owner === 'packages/api/src/io/added.js#helper');
    assert.equal(rows.length, 1, kind);
    assert.equal(rows[0].file, 'packages/api/src/io/added.js');
  }
});

test('clause 1: a known row that no longer fires fails so the set only shrinks [C7]', () => {
  const rows = apiRequestIoProblems(sources, { known: { ...KNOWN_REQUEST_BLOCKERS, 'packages/api/src/io/main.js#gone': 'already fixed' } });
  assert.deepEqual(rows.map(row => row.owner), ['packages/api/src/io/main.js#gone']);
  assert.equal(rows[0].stale, true);
});

test('clause 1: an unlisted call fails when its owner is missing from the known set [C7]', () => {
  const { 'packages/landing/src/io/main/red/receipt.js#treeOf': removed, ...rest } = KNOWN_REQUEST_BLOCKERS;
  assert.ok(removed);
  const rows = apiRequestIoProblems(sources, { known: rest });
  assert.deepEqual(rows.map(row => row.owner), ['packages/landing/src/io/main/red/receipt.js#treeOf']);
});

test('clause 1: a blocker reached from the view, relay or transport pull server fails the check [C7]', () => {
  const entries = { 'apps/view/src/io/serve.js': ['serveView', 'const server = createServer(async (req, res) => {'], 'apps/relay/src/io/service.js': ['createRelayHandler', null], 'packages/transport/src/io/pull/http.js': ['pullServer', null] };
  for (const [file, [name, anchor]] of Object.entries(entries)) {
    assert.ok(HTTP_SERVERS.includes(`${file}#${name}`), `${file}#${name} is an entry`);
    const folder = file.slice(0, file.lastIndexOf('/')), row = sources.find(entry => entry.file === file);
    const call = anchor ?? new RegExp(`export (?:async )?function ${name}\\([^)]*\\)\\s*\\{`, 'u').exec(row.source)[0];
    const source = "import { helper } from './added.js';\n" + row.source.replace(call, `${call}\n  helper();`);
    const injected = [...sources.filter(entry => entry.file !== file), { file, source },
      { file: `${folder}/added.js`, source: "import { spawnSync } from 'node:child_process';\nexport function helper() { return spawnSync('ls'); }" }];
    assert.deepEqual(apiRequestIoProblems(injected).map(found => found.owner), [`${folder}/added.js#helper`], file);
  }
});
