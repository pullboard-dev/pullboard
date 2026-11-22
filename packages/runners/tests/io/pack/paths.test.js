/** @pullboard-test-input source-tree */
/** Call-local historical path reuse preserves full prefixes and refuses incomplete inventories [C7]. */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { copyPackageFiles } from '../../../index.js';
import { privateFixtureFiles, runFixtureChild } from '../../../../gate/tests/fixtures/child.js';

/** Synthetic repositories and Git observations live only beneath this test's owned fixture root. */
const SETUP = `
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { historyPack } from './packages/runners/src/io/pack.js';
const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const repo = mkdtempSync(join(process.cwd(), 'repo-'));
const git = (...args) => execFileSync(process.env.FIXTURE_REAL_GIT, args, { cwd: repo, env, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
mkdirSync(join(repo, 'a')); mkdirSync(join(repo, 'z'));
for (const prefix of ['a', 'z']) for (let n = 0; n < 64; n++) writeFileSync(join(repo, prefix, 'leaf' + n + '.txt'), 'benign fixture ' + n + '\\n');
const commits = [];
for (let n = 0; n < 12; n++) {
  writeFileSync(join(repo, 'version.txt'), String(n));
  git('add', '.'); git('commit', '-q', '-m', 'fixture ' + n);
  commits.push(git('rev-parse', 'HEAD'));
}
assert.equal(git('rev-parse', 'HEAD:a'), git('rev-parse', 'HEAD:z'), 'one exact subtree is mounted at two prefixes');
const protect = { blocked: [], allowed: [], secrets: true };
const pack = (source = {}, tips = []) => {
  const directory = mkdtempSync(join(process.cwd(), 'pack-'));
  try { return { bytes: readFileSync(historyPack(repo, { commit: commits.at(-1), protect, ...source }, tips, directory)), directory }; }
  catch (error) { return { code: error.code, message: error.message, directory }; }
};
const launches = () => readFileSync(process.env.FIXTURE_LAUNCHES, 'utf8').trim().split('\\n').filter(Boolean);
const reset = () => writeFileSync(process.env.FIXTURE_LAUNCHES, '');
`;

/** Copy supported tooling without a scanner manifest; no verdict cache is manufactured or seeded. */
function run(t, script) {
  const { root } = privateFixtureFiles('pullboard-pack-paths-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const bin = join(root, 'shim');
  mkdirSync(bin);
  const real = runFixtureChild('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh
case " $* " in
  *" ls-tree "*)
    echo "$*" >> "$FIXTURE_LAUNCHES"
    case "$FIXTURE_TREE_REPLY" in
      fail) exit 1;;
      malformed) printf 'invalid\\000'; exit 0;;
    esac;;
esac
exec "$FIXTURE_REAL_GIT" "$@"
`);
  chmodSync(join(bin, 'git'), 0o755);
  const log = join(root, 'launches');
  writeFileSync(log, '');
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', SETUP + script], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      PULLBOARD_MACHINE_HOME: join(root, 'machine'), FIXTURE_REAL_GIT: real, FIXTURE_LAUNCHES: log, FIXTURE_TREE_REPLY: '' },
  });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  return result.stdout;
}

test('runners.pack-paths.shared-prefixes: clause 1: shared subtrees retain both full prefixes, exact pack bytes and duplicate roots with fewer recursive Git jobs [C7]', t => {
  const output = run(t, `
const expected = execFileSync(process.env.FIXTURE_REAL_GIT, ['pack-objects', '--stdout'], {
  cwd: repo, env, input: git('rev-list', '--objects', commits.at(-1)).split('\\n').map(line => line.split(' ')[0]).join('\\n') + '\\n',
});
reset();
const first = pack();
assert.deepEqual(first.bytes, expected, 'pack object selection and order are unchanged');
const observed = launches();
const recursive = observed.filter(line => line.split(' ').includes('-r')).length;
assert.equal(recursive, 0, 'full root expansions are replaced with call-local subtree inventories');
assert.equal(observed.length, 13, 'twelve distinct roots and one shared subtree are each read once');
reset();
assert.deepEqual(pack({ extraCommits: [commits[0], commits.at(-1), commits[0]] }).bytes, expected, 'duplicate roots do not alter output or order');
assert.equal(launches().length, 13, 'another call reads its own inventory; no persistent shortcut');
assert.deepEqual(pack({}, [commits.at(-1)]).bytes, execFileSync(process.env.FIXTURE_REAL_GIT, ['pack-objects', '--stdout'], { cwd: repo, env, input: '' }), 'a known root still gives the exact empty object pack');
const blocked = pack({ protect: { ...protect, blocked: ['z/leaf0.txt'] } });
assert.equal(blocked.code, 'RUNNER_SECRET', 'a clean shared subtree at a does not vouch for z');
const allowed = pack({ protect: { ...protect, blocked: ['z/leaf0.txt'], allowed: ['z/leaf0.txt'] } });
assert.deepEqual(allowed.bytes, expected, 'each call applies its own exact allowed and blocked policy');
console.log(JSON.stringify({ historicalRoots: 12, recursiveJobs: recursive, inventoryJobs: observed.length }));
`);
  t.diagnostic(output.trim());
});

test('runners.pack-paths.fail-closed: clause 1: malformed and failed Git scans refuse without a pack and an extra historical root retains its policy binding [C7]', t => {
  run(t, `
for (const [reply, code] of [['malformed', 'RUNNER_SECRET'], ['fail', 'RUNNER_SOURCE']]) {
  process.env.FIXTURE_TREE_REPLY = reply;
  const refused = pack();
  assert.equal(refused.code, code);
  assert.throws(() => readFileSync(join(refused.directory, 'source.pack')), { code: 'ENOENT' });
}
process.env.FIXTURE_TREE_REPLY = '';
const tree = git('mktree', '-z');
const extra = git('commit-tree', tree, '-m', 'empty side');
const safe = pack({ extraCommits: [extra] });
assert.ok(safe.bytes);
const empty = mkdtempSync(join(process.cwd(), 'cold-'));
execFileSync(process.env.FIXTURE_REAL_GIT, ['init', '-q', '--bare', empty], { env });
execFileSync(process.env.FIXTURE_REAL_GIT, ['index-pack', '--stdin'], { cwd: empty, env, input: safe.bytes });
execFileSync(process.env.FIXTURE_REAL_GIT, ['cat-file', '-e', extra], { cwd: empty, env });
const old = commits[0];
const refused = pack({ commit: extra, extraCommits: [old], protect: { ...protect, blocked: ['z/leaf0.txt'] } });
assert.equal(refused.code, 'RUNNER_SECRET', 'an extra root is checked even when the primary root is empty');
assert.throws(() => readFileSync(join(refused.directory, 'source.pack')), { code: 'ENOENT' });
`);
});
