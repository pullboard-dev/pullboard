/** Runner source history can exceed a single blob limit without losing its safety bound [H16,C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { protectHistory } from '../../../index.js';
import { sourceGit } from '../../../index.js';
import { sourceObjects } from '../../../index.js';
import { defaults } from '../../../../config/index.js';

/** Construct history with long names using shared blob objects, without checking files out. */
test('runners.bound.runner-history-above-8-mib-scans: runner history above 8 MiB scans and reports an actual smaller bound with byte count [H16,C7]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-history-bound-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const names = Array.from({ length: 11000 }, (_, index) => `data/${String(index).padStart(5, '0')}-${'x'.repeat(195)}.txt`);
  const files = names.map(name => `M 100644 :1 ${name}\n`).join('');
  const person = 'Fixture <fixture@example.invalid> 1700000000 +0000';
  const commits = [0, 1, 2, 3].map((index) => `commit refs/heads/main\ncommitter ${person}\ndata 2\nc${index}\n${index % 2 ? 'deleteall\n' : files}\n`).join('');
  execFileSync('git', ['fast-import', '--quiet'], { cwd: root, input: `blob\nmark :1\ndata 1\nx\n${commits}`, maxBuffer: 16 * 1024 * 1024 });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const args = ['log', '--format=', '--name-only', '-z', '--no-renames', '--root', '-m', '--full-history', commit];
  const bytes = Buffer.byteLength(sourceGit(root, args, { maxBuffer: 32 * 1024 * 1024 }));
  assert.ok(bytes > 8 * 1024 * 1024, `fixture history is ${bytes} bytes`);
  assert.doesNotThrow(() => sourceObjects(root, { commit }));
  assert.doesNotThrow(() => protectHistory(root, { commit }, [defaults().protect]));
  assert.throws(() => sourceGit(root, args, { maxBuffer: 8 * 1024 * 1024 }), error => {
    assert.equal(error.code, 'RUNNER_SOURCE');
    assert.match(error.message, new RegExp(`${bytes} bytes.*8388608-byte bound`));
    return true;
  });
});

/** Commit one file in a private fixture repository and return the new commit. */
function commitFile(root, path, body) {
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', path], { cwd: root,
    env: { ...process.env, GIT_INDEX_FILE: join(root, '.git', 'index') }, input: body });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

test('runners.bound.a-clean-history-verdict-is-cached: a clean history verdict is cached per commit, so a descendant scan reads only its new commits; blocked new paths still refuse [C7]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-history-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const add = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
    execFileSync('git', ['add', path], { cwd: root });
    return commitFile(root, path, '');
  };
  const policies = [defaults().protect];
  const first = add('old/first.txt', 'one\n');
  const cached = add('src/second.txt', 'two\n');
  protectHistory(root, { commit: cached }, policies);
  const descendant = add('src/third.txt', 'three\n');
  // Removing the first commit's tree makes any scan that reads that far fail, so only an incremental scan can pass.
  const tree = execFileSync('git', ['rev-parse', `${first}^{tree}`], { cwd: root, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-index', '--force-remove', 'old/first.txt'], { cwd: root });
  rmSync(join(root, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
  assert.doesNotThrow(() => protectHistory(root, { commit: descendant }, policies), 'the descendant scan reads only the commits after the cached one');
  assert.throws(() => protectHistory(root, { commit: descendant }, [{ ...defaults().protect, fresh: true }]), { code: 'RUNNER_SOURCE' },
    'other policies have no cached ancestor, so they scan all history');
  const blocked = add('data/board.sqlite', 'private\n');
  assert.throws(() => protectHistory(root, { commit: blocked }, policies), { code: 'RUNNER_SECRET' }, 'a blocked path in new commits is still refused');
});
