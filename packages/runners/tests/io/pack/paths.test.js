/** @pullboard-test-input packages/runners/src/io/pack.js packages/runners/src/io/source/scan.js */
/** Call-local historical path reuse preserves full prefixes and refuses incomplete inventories [C7]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { copyPackageFiles } from '../../../index.js';
import { fixtureCommittedGraph } from '../../../../gate/tests/fixtures/testkit.js';
import { runFixtureChild } from '../../../../gate/tests/fixtures/child.js';

/** Synthetic repositories and Git observations live only beneath this test's owned fixture root. */
const LEGACY_PATH_CHECK = `
  for (const tree of historicalTrees) {
    for (const record of streamedSourceGit(root, ['ls-tree', '-r', '-z', '--full-tree', tree], directory, 'history.tree').split('\\0').filter(Boolean)) {
      const match = /^(\\d+) (\\w+) [a-f0-9]{40,64}\\t([\\s\\S]+)$/u.exec(record);
      if (!match || match[2] !== 'blob' || protectedHistoryPath(match[3], config.protect)) {
        throw new Refused('RUNNER_SECRET', 'historical source includes a blocked private path or submodule; keep this run local');
      }
    }
  }
`;

/** Both implementations run on exactly the same synthetic graph, scanner, policy and root arguments. */
const SETUP = `
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { historyPack } from './packages/runners/src/io/pack.js';
import { historyPack as legacyHistoryPack } from './packages/runners/src/io/legacy-pack.js';
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
const pack = (source = {}, tips = [], implementation = historyPack) => {
  const directory = mkdtempSync(join(process.cwd(), 'pack-'));
  globalThis.fixturePathChecks = 0;
  try { return { bytes: readFileSync(implementation(repo, { commit: commits.at(-1), protect, ...source }, tips, directory)), checks: globalThis.fixturePathChecks, directory }; }
  catch (error) { return { code: error.code, message: error.message, directory }; }
};
const launches = () => readFileSync(process.env.FIXTURE_LAUNCHES, 'utf8').trim().split('\\n').filter(Boolean);
const reset = () => writeFileSync(process.env.FIXTURE_LAUNCHES, '');
`;

/** Copy tooling into an isolated fixture Git repository; all comparison reads and mutations stay in that copy. */
function run(t, script) {
  const { root } = fixtureCommittedGraph('pullboard-pack-paths-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const packFile = join(root, 'packages/runners/src/io/pack.js');
  const current = readFileSync(packFile, 'utf8');
  const call = '  checkHistoricalPaths(root, historicalTrees, config.protect, directory, treeEntries);';
  assert.ok(current.includes(call), 'the fixture comparator replaces only the historical full-path check');
  writeFileSync(join(root, 'packages/runners/src/io/legacy-pack.js'), current.replace(call, LEGACY_PATH_CHECK));
  const scanFile = join(root, 'packages/runners/src/io/source/scan.js');
  const scan = readFileSync(scanFile, 'utf8');
  const signature = 'export function protectedHistoryPath(path, protect) {';
  assert.ok(scan.includes(signature));
  writeFileSync(scanFile, scan.replace(signature, signature + '\n  globalThis.fixturePathChecks = (globalThis.fixturePathChecks ?? 0) + 1;'));
  const bin = join(root, 'shim');
  mkdirSync(bin);
  const real = runFixtureChild('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh
echo "$*" >> "$FIXTURE_LAUNCHES"
case " $* " in
  *"cat-file --batch "*)
    case "$FIXTURE_TREE_REPLY" in
      fail) exit 1;;
      malformed) printf 'invalid\\000'; exit 0;;
    esac;;
  *" ls-tree "*)
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

test('runners.pack-paths.shared-prefixes: clause 1: existing tree stream reduces total Git jobs and repeated path checks with exact full-prefix, policy, root and object-order parity [C7]', t => {
  const output = run(t, `
const expected = execFileSync(process.env.FIXTURE_REAL_GIT, ['pack-objects', '--stdout'], {
  cwd: repo, env, input: git('rev-list', '--objects', commits.at(-1)).split('\\n').map(line => line.split(' ')[0]).join('\\n') + '\\n',
});
reset();
const baseline = pack({}, [], legacyHistoryPack);
const before = launches().length;
reset();
const first = pack();
const after = launches().length;
assert.deepEqual(first.bytes, expected, 'exact object order matches independent Git selection');
assert.deepEqual(first.bytes, baseline.bytes, 'the original recursive path walk produces identical bytes');
assert.equal(before - after, 12, 'the twelve root ls-tree processes disappear without replacement Git launches');
assert.ok(first.checks < baseline.checks, 'actual full-path policy invocations fall across repeated subtrees');
assert.ok(first.checks > 128, 'both mounts and each root still undergo their full-prefix checks');
reset();
const duplicate = { extraCommits: [commits[0], commits.at(-1), commits[0]] };
assert.deepEqual(pack(duplicate).bytes, pack(duplicate, [], legacyHistoryPack).bytes, 'duplicate root argument ordering matches the original exactly');
const policies = [
  protect,
  { ...protect, blocked: ['z/leaf0.txt'] },
  { ...protect, blocked: ['z/leaf0.txt'], allowed: ['z/leaf0.txt'] },
  { ...protect, blocked: ['a/leaf0.txt'] },
];
for (const policy of policies) {
  const source = { protect: policy };
  const actual = pack(source), original = pack(source, [], legacyHistoryPack);
  assert.equal(actual.code, original.code);
  assert.equal(actual.message, original.message);
  assert.deepEqual(actual.bytes, original.bytes, 'each exact policy retains its original result');
}
assert.equal(pack({ protect: policies[1] }).code, 'RUNNER_SECRET', 'a clean mount at a cannot vouch for z');
assert.ok(pack({ protect: policies[2] }).bytes, 'the exact allowed exception remains effective');
for (const tips of [[commits.at(-1)], [commits[0]]]) {
  assert.deepEqual(pack({}, tips).bytes, pack({}, tips, legacyHistoryPack).bytes, 'known history and incomplete tree-stream closures retain exact original output');
}
reset(); pack();
assert.equal(launches().length, after, 'another call performs its own complete scan without persistent proofs');
console.log(JSON.stringify({ historicalRoots: 12, totalGitBefore: before, totalGitAfter: after, pathChecksBefore: baseline.checks, pathChecksAfter: first.checks }));
`);
  t.diagnostic(output.trim());
});

test('runners.pack-paths.fail-closed: clause 1: unknown scanner identity still scans, failed or malformed streams refuse, and every extra historical root retains exact policy and error parity [C7]', t => {
  run(t, `
for (const [reply, code] of [['malformed', 'RUNNER_SOURCE'], ['fail', 'RUNNER_SOURCE']]) {
  process.env.FIXTURE_TREE_REPLY = reply;
  const refused = pack(), original = pack({}, [], legacyHistoryPack);
  assert.equal(refused.code, code);
  assert.equal(refused.code, original.code);
  assert.equal(refused.message, original.message);
  assert.throws(() => readFileSync(join(refused.directory, 'source.pack')), { code: 'ENOENT' });
}
process.env.FIXTURE_TREE_REPLY = '';
const tree = git('mktree', '-z');
const extra = git('commit-tree', tree, '-m', 'empty side');
const source = { extraCommits: [extra] };
const safe = pack(source);
assert.deepEqual(safe.bytes, pack(source, [], legacyHistoryPack).bytes);
const empty = mkdtempSync(join(process.cwd(), 'cold-'));
execFileSync(process.env.FIXTURE_REAL_GIT, ['init', '-q', '--bare', empty], { env });
execFileSync(process.env.FIXTURE_REAL_GIT, ['index-pack', '--stdin'], { cwd: empty, env, input: safe.bytes });
execFileSync(process.env.FIXTURE_REAL_GIT, ['cat-file', '-e', extra], { cwd: empty, env });
const old = commits[0];
const blocked = { commit: extra, extraCommits: [old], protect: { ...protect, blocked: ['z/leaf0.txt'] } };
const refused = pack(blocked), original = pack(blocked, [], legacyHistoryPack);
assert.equal(refused.code, 'RUNNER_SECRET', 'unknown scanner identity never skips checks on an extra root');
assert.equal(refused.message, original.message);
assert.throws(() => readFileSync(join(refused.directory, 'source.pack')), { code: 'ENOENT' });
`);
});
