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

test('clause 1: a new spawnSync, execSync, gitSpawnSync, readdirSync or Atomics.wait call reached from a handler outside the list fails [C7]', () => {
  const calls = { spawn: "import { spawnSync } from 'node:child_process';\nexport function helper() { return spawnSync('ls'); }",
    exec: "import { execSync } from 'node:child_process';\nexport function helper() { return execSync('ls'); }",
    git: "import { gitSpawnSync } from '../../../git/index.js';\nexport function helper() { return gitSpawnSync(['status']); }",
    readdir: "import { readdirSync } from 'node:fs';\nexport function helper() { return readdirSync('.'); }",
    atomics: "export function helper() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }" };
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

/** The tree's sources with `file` rewritten, and one added module whose `helper` makes a synchronous child process. */
function withCallback(file, rewrite) {
  const added = { file: 'packages/jobs/src/io/callback-added.js', source: "import { spawnSync } from 'node:child_process';\nexport function addedBlocker() { return spawnSync('ls'); }\n" };
  const edited = sources.map(row => row.file === file ? { ...row, source: rewrite(row.source) } : row);
  return [...edited, added];
}
/** The import of the added module, written relative to the rewritten file. */
const importAdded = file => `import { addedBlocker } from '${'../'.repeat(file.split('/').length - 1)}packages/jobs/src/io/callback-added.js';\n`;

test('#6756 clause 1: a spawnSync reached through a function in the viewPorts handed to the board API fails the check [C7]', () => {
  const rows = apiRequestIoProblems(withCallback('apps/view/src/io/ports.js',
    source => importAdded('apps/view/src/io/ports.js') + source.replace('Object.freeze({ ', 'Object.freeze({ addedBlocker, '))).filter(row => row.owner === 'packages/jobs/src/io/callback-added.js#addedBlocker');
  assert.equal(rows.length, 1);
  assert.match(rows[0].chain[0], /viewPorts/u);
});

test('#6756 clause 2: a blocker reached through a settings provider or through runCommand fails the check [C7]', () => {
  const owner = row => row.owner === 'packages/jobs/src/io/callback-added.js#addedBlocker';
  const provider = apiRequestIoProblems(withCallback('apps/cli/src/io/commands/serve.js',
    source => importAdded('apps/cli/src/io/commands/serve.js') + source.replace('settingsProviders: { ', 'settingsProviders: { addedBlocker, '))).filter(owner);
  assert.equal(provider.length, 1);
  assert.match(provider[0].chain[0], /settingsProviders/u);
  const command = apiRequestIoProblems(withCallback('apps/cli/src/io/main.js',
    source => importAdded('apps/cli/src/io/main.js') + source.replace('export async function main(argv, streams) {', 'export async function main(argv, streams) {\n  addedBlocker();'))).filter(owner);
  assert.equal(command.length, 1);
  assert.equal(command[0].chain[0], 'apps/cli/src/io/main.js#main');
});

test('#6756 clause 2: a callback list the check cannot find fails instead of passing silently [C7]', () => {
  const rows = apiRequestIoProblems(sources.map(row => row.file === 'apps/view/src/io/ports.js' ? { ...row, source: row.source.replace('viewApiPorts', 'renamedPorts') } : row))
    .filter(row => row.stale && /viewPorts/u.test(row.call));
  assert.equal(rows.length, 1);
});

test('clause 2: every known violation is listed by file and function, and the check finds no blocker beyond them [C7]', () => {
  for (const owner of Object.keys(KNOWN_REQUEST_BLOCKERS)) assert.match(owner, /^[\w./-]+\.js#[\w$]+$/u, owner);
  assert.deepEqual(apiRequestIoProblems(sources), []);
});

test('#6755 clause 1: a known-violation row is keyed by the file and function of the call site itself, whatever order the tree is walked in [C7]', () => {
  const owners = rows => rows.map(row => `${row.owner} ${row.call}`).sort();
  const shared = { file: 'packages/git/src/io/added-shared.js', source: "import { spawnSync } from 'node:child_process';\nexport function sharedGit() { return spawnSync('git'); }\n" };
  const callers = ['a', 'b'].map(name => ({ file: `packages/api/src/io/added-${name}.js`, source: `import { sharedGit } from '../../../git/src/io/added-shared.js';\nexport function ${name}Handler() { return sharedGit(); }\n` }));
  const injected = [...sources, shared, ...callers];
  const forward = apiRequestIoProblems(injected, { known: {} });
  assert.deepEqual(owners(apiRequestIoProblems([...injected].reverse(), { known: {} })), owners(forward), 'walk order changes no row');
  const rows = forward.filter(row => row.file === shared.file);
  assert.deepEqual(rows.map(row => row.owner), ['packages/git/src/io/added-shared.js#sharedGit'], 'the row names the call site, not the caller that reached it first');
  for (const row of forward) assert.equal(row.owner, `${row.file}#${row.chain.at(-1).split('#')[1]}`, 'owner is the call site');
});

test('clause 2: the known set holds the current Atomics.wait and readdirSync sites by file and function [C7]', () => {
  assert.ok('packages/store/src/io/board/busy.js#beginImmediateQueued' in KNOWN_REQUEST_BLOCKERS);
  for (const owner of ['apps/relay/src/io/retention.js#backupFiles', 'packages/keys/src/io/relay.js#scrubLegacyPersonSessions', 'packages/link/src/io/relay/lock.js#locked', 'packages/link/src/io/relay/machine.js#readRelayMachine', 'packages/store/src/io/board/write/lock.js#boardWriteHolderText']) {
    assert.ok(owner in KNOWN_REQUEST_BLOCKERS, owner);
  }
  const rows = apiRequestIoProblems(sources, { known: {} }).map(row => row.call);
  assert.ok(rows.includes('global:Atomics#wait') && rows.includes('node:fs#readdirSync'));
});
