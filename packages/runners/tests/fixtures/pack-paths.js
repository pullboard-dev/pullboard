/** @pullboard-test-input packages/runners/src/io/pack.js packages/runners/src/io/source/scan.js */
/** @pullboard-module-loads packages/runners/src/io/pack.js packages/runners/src/io/source/scan.js */
/** Run actual history pack comparisons in process, with an owned Git shim and a restored environment [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyPackageFiles } from '../../index.js';
import { fixture } from './package-files.js';
import { runTestGit } from './git.js';

/** The original recursive path checker, used only in the second private copy of the real pack module. */
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


/** Copy actual tooling into a private Git repository, retaining every production scanner dependency. */
function copiedTooling(root) {
  const source = resolve(import.meta.dirname, '../../../..');
  copyPackageFiles(source, root);
  // The comparator has its own manifest-validated source copy; never hand-copy installed runtime bytes.
  copyPackageFiles(source, root, { files: [{
    path: 'packages/runners/src/io/pack.js', as: 'packages/runners/src/io/legacy-pack.js',
  }] });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const legacyFile = join(root, 'packages/runners/src/io/legacy-pack.js');
  const legacy = readFileSync(legacyFile, 'utf8');
  const call = '  checkHistoricalPaths(root, historicalTrees, config.protect, directory, treeEntries);';
  assert.ok(legacy.includes(call), 'only the full-path check differs in the comparator');
  // Only this explicit synthetic comparator changes; the current module remains the complete manifest copy.
  writeFileSync(legacyFile, legacy.replace(call, LEGACY_PATH_CHECK));
  const scanFile = join(root, 'packages/runners/src/io/source/scan.js');
  const scan = readFileSync(scanFile, 'utf8');
  const signature = 'export function protectedHistoryPath(path, protect) {';
  assert.ok(scan.includes(signature));
  // This counts actual calls in the owned copy, shared by old and current modules; no production module is modified.
  writeFileSync(scanFile, 'export let fixturePathChecks = 0;\nexport function resetFixturePathChecks() { fixturePathChecks = 0; }\n'
    + scan.replace(signature, signature + '\n  fixturePathChecks++;'));
}

/** Install an actual executable Git shim; all processes it records still execute the real Git binary. */
function gitShim(root, real) {
  const bin = join(root, 'shim');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh
echo "$*" >> "$FIXTURE_LAUNCHES"
case " $* " in
  *"cat-file --batch "*|*" ls-tree "*)
    case "$FIXTURE_TREE_REPLY" in
      fail) exit 1;;
      malformed) printf 'invalid\\000'; exit 0;;
    esac;;
esac
exec "$FIXTURE_REAL_GIT" "$@"
`);
  chmodSync(join(bin, 'git'), 0o755);
  return { bin, real };
}

/** Create the same benign twelve-root graph and two mounts of one immutable subtree as the original regression. */
async function graph(directory, real, env) {
  const repo = directory('repo');
  /** Run real Git outside the observed pack-call window for fixture construction and independent expectations. */
  const git = (...args) => execFileSync(real, args, { cwd: repo, env, encoding: 'utf8' }).trim();
  const initialized = await runTestGit(repo, ['init', '-q', '-b', 'main']);
  assert.equal(initialized.status, 0, 'the existing own-cell Git adapter initializes the owned repo');
  mkdirSync(join(repo, 'a')); mkdirSync(join(repo, 'z'));
  for (const prefix of ['a', 'z']) for (let n = 0; n < 64; n++) {
    writeFileSync(join(repo, prefix, 'leaf' + n + '.txt'), 'benign fixture ' + n + '\n');
  }
  const commits = [];
  for (let n = 0; n < 12; n++) {
    writeFileSync(join(repo, 'version.txt'), String(n));
    git('add', '.'); git('commit', '-q', '-m', 'fixture ' + n);
    commits.push(git('rev-parse', 'HEAD'));
  }
  assert.equal(git('rev-parse', 'HEAD:a'), git('rev-parse', 'HEAD:z'), 'one exact subtree is mounted at two prefixes');
  return { repo, git, commits };
}

/**
 * Run the case in this process. Like the existing Runners pool/fleet fixtures, environment changes last only through
 * the awaited callback and are restored even on a refusal. Only real Git and the shell shim are child processes.
 */
export async function withPackPaths(t, work) {
  const owned = fixture(t);
  const root = join(owned.directory, 'tooling');
  mkdirSync(root);
  let sequence = 0;
  /** Allocate a regular child directory beneath the existing own-cell fixture's private, cleanup-owned root. */
  const directory = kind => {
    const path = join(root, kind + '-' + sequence++);
    mkdirSync(path);
    return path;
  };
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  copiedTooling(root);
  const { bin } = gitShim(root, real);
  const log = join(root, 'launches');
  writeFileSync(log, '');
  const changes = { PATH: `${bin}:${process.env.PATH}`, PULLBOARD_MACHINE_HOME: join(root, 'machine'),
    FIXTURE_REAL_GIT: real, FIXTURE_LAUNCHES: log, FIXTURE_TREE_REPLY: '',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  // Fixture Git commands must never inherit an index, object directory or worktree selector from this runner.
  const gitKeys = Object.keys(process.env).filter(key => key.startsWith('GIT_'));
  const keys = [...new Set([...Object.keys(changes), ...gitKeys])];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of gitKeys) delete process.env[key];
    Object.assign(process.env, changes);
    const env = { ...process.env };
    const initialized = await runTestGit(root, ['init', '-q', '-b', 'main']);
    assert.equal(initialized.status, 0, 'the copied tooling lives in a real owned Git repository');
    const { historyPack } = await import(pathToFileURL(join(root, 'packages/runners/src/io/pack.js')).href);
    const { historyPack: legacyHistoryPack } = await import(pathToFileURL(join(root, 'packages/runners/src/io/legacy-pack.js')).href);
    const scanner = await import(pathToFileURL(join(root, 'packages/runners/src/io/source/scan.js')).href);
    assert.equal(scanner.scannerTree(), null, 'no scanner identity is invented for the fixture; complete scans remain mandatory');
    const { repo, git, commits } = await graph(directory, real, env);
    const protect = { blocked: [], allowed: [], secrets: true };
    /** Run one actual implementation and retain its exact bytes or native refusal. */
    const pack = (source = {}, tips = [], implementation = historyPack) => {
      const packDirectory = directory('pack');
      scanner.resetFixturePathChecks();
      try { return { bytes: readFileSync(implementation(repo, { commit: commits.at(-1), protect, ...source }, tips, packDirectory)),
        checks: scanner.fixturePathChecks, directory: packDirectory }; }
      catch (error) { return { code: error.code, message: error.message, directory: packDirectory }; }
    };
    /** Ask independent real Git for exactly the original ordered object pack. */
    const expected = () => execFileSync(real, ['pack-objects', '--stdout'], { cwd: repo, env,
      input: git('rev-list', '--objects', commits.at(-1)).split('\n').map(line => line.split(' ')[0]).join('\n') + '\n' });
    /** Import a real produced pack into a separate cold object database and prove an extra commit exists there. */
    const importExtra = async (bytes, extra) => {
      const cold = directory('cold');
      const initialized = await runTestGit(cold, ['init', '-q', '--bare', '.']);
      assert.equal(initialized.status, 0, 'the cold pack target is a real owned Git repository');
      execFileSync(real, ['index-pack', '--stdin'], { cwd: cold, env, input: bytes });
      execFileSync(real, ['cat-file', '-e', extra], { cwd: cold, env });
    };
    return await work({ pack, legacyHistoryPack, expected, importExtra, git, commits, protect,
      launches: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
      reset: () => writeFileSync(log, ''), setReply: reply => { process.env.FIXTURE_TREE_REPLY = reply; } });
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
}
