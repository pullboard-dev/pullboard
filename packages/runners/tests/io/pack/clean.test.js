/** @pullboard-test-input source-cell packages/runners */
/** A runner history pack reads again only the history no earlier clean scan covered, and still packs everything the runner lacks [C7,#5544]. */
import { copyPackageFiles } from '../../../index.js';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../gate/tests/fixtures/child.js';

/** The script run inside the copied tooling: four commits packed for a cold runner, the shim logging each scan's size. */
const SCRIPT = `
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { historyPack } from './packages/runners/src/io/pack.js';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.test', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.test' } }).trim();
const repo = mkdtempSync(join(process.cwd(), 'repo-'));
git(repo, 'init', '-q', '-b', 'main');
const commit = (name, body) => { writeFileSync(join(repo, name), body); git(repo, 'add', name); git(repo, 'commit', '-q', '-m', name); return git(repo, 'rev-parse', 'HEAD'); };
const pack = (id, tips) => {
  const file = historyPack(repo, { commit: id }, tips, mkdtempSync(join(process.cwd(), 'dir-')));
  const cold = mkdtempSync(join(process.cwd(), 'cold-'));
  git(cold, 'init', '-q', '--bare', '.');
  execFileSync('git', ['index-pack', '--stdin'], { cwd: cold, input: readFileSync(file) });
  return git(repo, 'rev-list', '--objects', id).split('\\n').every(line => { try { git(cold, 'cat-file', '-e', line.split(' ')[0]); return true; } catch { return false; } });
};
const first = commit('a.txt', 'one\\n');
const second = commit('b.txt', 'two\\n');
const third = commit('c.txt', 'three\\n');
const fourth = commit('d.txt', 'four\\n');
const side = git(repo, 'commit-tree', git(repo, 'hash-object', '-t', 'tree', '-w', '--stdin'), '-m', 'side');
const holds = [pack(first, []), pack(second, []), pack(third, [side]), pack(fourth, [])];
console.log(JSON.stringify({ holds, third, fourth }));`;

test('a cold runner gets every object while only history past the last clean scan is read again (clause 1) [C7,#5544]', t => {
  const root = realpathSync(privateFixtureFiles('pullboard-clean-pack-').root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, '.pullboard-runner-source.json'), JSON.stringify({ tree: 'b'.repeat(40) }));
  // A git shim that appends the number of objects each `cat-file --batch` scan is asked to read.
  const bin = join(root, 'shim');
  mkdirSync(bin);
  const real = runFixtureChild('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh
case "$*" in
  *"cat-file --batch") f=$(mktemp); cat > "$f"; wc -l < "$f" | tr -d ' ' >> "${join(root, 'scans.log')}"; ${real} "$@" < "$f"; code=$?; rm -f "$f"; exit $code;;
esac
exec ${real} "$@"
`);
  chmodSync(join(bin, 'git'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PULLBOARD_MACHINE_HOME: join(root, 'machine') };
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', SCRIPT], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const out = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.deepEqual(out.holds, [true, true, true, true], 'every pack from a cold runner holds the whole history of its commit');
  const scans = readFileSync(join(root, 'scans.log'), 'utf8').split('\n').filter(Boolean).map(Number);
  assert.deepEqual(scans, [3, 3, 3, 6], 'each pack reads a commit, tree and blob per commit past the last clean scan; the one after an unproven tip reads two commits');
  const [file] = readdirSync(join(root, 'machine', 'pack-scan'));
  const saved = JSON.parse(readFileSync(join(root, 'machine', 'pack-scan', file), 'utf8'));
  assert.ok(saved.includes(out.fourth), 'the last commit\'s full scan is kept');
  assert.equal(saved.includes(out.third), false, 'a scan that trusted a runner-claimed tip no clean scan covers is not kept');
});
