/** protectHistory reads only commits past the last clean one, and a blocked path anywhere in history is still refused [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import { defaults } from '../../../../config/index.js';
import { protectHistory } from '../../../index.js';

/** A fresh repository whose add() commits one file and returns the new commit. */
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-history-incremental-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const add = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
    execFileSync('git', ['add', path], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', path], { cwd: root });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  };
  return { root, add };
}

test('asked twice for commits one apart, protectHistory reads only the new commit paths (clause 1) [C7]', t => {
  const { root, add } = repo(t);
  const policies = [defaults().protect];
  const first = add('old/first.txt', 'one\n');
  const second = add('src/second.txt', 'two\n');
  protectHistory(root, { commit: second }, policies);
  const third = add('src/third.txt', 'three\n');
  // Dropping the first commit's tree makes any scan that reaches it fail, so only an incremental scan passes.
  const tree = execFileSync('git', ['rev-parse', `${first}^{tree}`], { cwd: root, encoding: 'utf8' }).trim();
  rmSync(join(root, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
  assert.doesNotThrow(() => protectHistory(root, { commit: third }, policies), 'only the commit after the clean one is read');
  assert.throws(() => protectHistory(root, { commit: third }, [{ ...defaults().protect, fresh: true }]), { code: 'RUNNER_SOURCE' }, 'with no clean ancestor the scan reads everything');
});

test('a blocked path anywhere in history is still refused (clause 2) [C7]', t => {
  const { root, add } = repo(t);
  const policies = [defaults().protect];
  add('data/board.sqlite', 'private\n');
  add('src/clean.txt', 'clean\n');
  const head = add('src/later.txt', 'later\n');
  assert.throws(() => protectHistory(root, { commit: head }, policies), { code: 'RUNNER_SECRET' }, 'an old blocked path refuses the whole history');
  const second = repo(t);
  const clean = second.add('src/a.txt', 'a\n');
  protectHistory(second.root, { commit: clean }, policies);
  const blocked = second.add('data/board.sqlite', 'private\n');
  assert.throws(() => protectHistory(second.root, { commit: blocked }, policies), { code: 'RUNNER_SECRET' }, 'a blocked path in new commits is refused');
});
