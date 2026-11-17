/** @pullboard-test-input source-cell packages/landing */
/** Landing receipts use the earliest first-parent commit, with logarithmic ancestry probes [B3,R3,C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { firstContainingCommit } from '../../../src/io/step/merge.js';

/** Locate the actual Git executable before installing the fixture's counting shim. */
function realGitPath() {
  const found = process.env.PATH.split(delimiter).map(folder => join(folder || '.', 'git')).find(existsSync);
  assert.ok(found, 'Git is available to build a real history fixture');
  return found;
}

/** Run one Git command while constructing the private graph, outside the measured query. */
function git(realGit, cwd, args, options = {}) {
  const result = spawnSync(realGit, args, { cwd, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

/** Add one fast-import commit, optionally rooted at a previous mark and merging another mark. */
function importedCommit(ref, mark, parent, message, merge, contents) {
  return `commit ${ref}\nmark :${mark}\ncommitter Fixture <fixture@example.test> 1700000000 +0000\ndata ${message.length}\n${message}\n` +
    `${parent ? `from :${parent}\n` : ''}${merge ? `merge :${merge}\n` : ''}M 100644 inline history.txt\ndata ${contents.length}\n${contents}\n`;
}

test('landing.merge.first-containing-commit-is-exact-across: first containing commit is exact across trunk, merge and absent sources with logarithmic probes [B3,R3,C7]', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-landing-attribution-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  const shims = join(dir, 'shims');
  const calls = join(dir, 'ancestry-calls.log');
  mkdirSync(root);
  mkdirSync(shims);
  const realGit = realGitPath();
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  git(realGit, root, ['init', '-q', '-b', 'main'], { env });
  let input = '';
  input += importedCommit('refs/heads/main', 1, null, 'main root', null, '0');
  for (let mark = 2; mark <= 256; mark++) input += importedCommit('refs/heads/main', mark, mark - 1, `main ${mark}`, null, String(mark));
  input += importedCommit('refs/heads/feature', 257, 128, 'feature source', null, 'feature');
  let mainTip = 256;
  for (let mark = 258; mark <= 768; mark++) {
    input += importedCommit('refs/heads/main', mark, mainTip, `main ${mark}`, null, String(mark));
    mainTip = mark;
  }
  input += importedCommit('refs/heads/main', 769, 768, 'merge feature', 257, 'merged');
  for (let mark = 770; mark <= 1024; mark++) input += importedCommit('refs/heads/main', mark, mark - 1, `main ${mark}`, null, String(mark));
  input += importedCommit('refs/heads/orphan', 1025, null, 'absent source', null, 'orphan');
  git(realGit, root, ['fast-import', '--quiet'], { env, input });

  const chain = git(realGit, root, ['rev-list', '--first-parent', '--reverse', 'refs/heads/main']).split('\n');
  const merge = chain[767];
  const sourceOnMain = chain[127];
  const feature = git(realGit, root, ['rev-parse', 'refs/heads/feature']);
  const orphan = git(realGit, root, ['rev-parse', 'refs/heads/orphan']);
  const shim = join(shims, 'git');
  writeFileSync(shim, '#!/bin/sh\ncase "$*" in *"merge-base --is-ancestor"*) printf "probe\\n" >> "$PULLBOARD_ANCESTRY_CALLS";; esac\nexec "$PULLBOARD_REAL_GIT" "$@"\n');
  chmodSync(shim, 0o700);
  const oldPath = process.env.PATH;
  const oldRealGit = process.env.PULLBOARD_REAL_GIT;
  const oldCalls = process.env.PULLBOARD_ANCESTRY_CALLS;
  process.env.PATH = `${shims}${delimiter}${oldPath}`;
  process.env.PULLBOARD_REAL_GIT = realGit;
  process.env.PULLBOARD_ANCESTRY_CALLS = calls;
  try {
    assert.equal(firstContainingCommit(root, feature), merge, 'a secondary-parent source first appears at its mainline merge');
    assert.equal(firstContainingCommit(root, sourceOnMain), sourceOnMain, 'a source already on trunk keeps its earliest commit');
    assert.equal(firstContainingCommit(root, orphan), undefined, 'a source absent from trunk has no containing commit');
    writeFileSync(calls, '');
    assert.equal(firstContainingCommit(root, feature), merge);
    const probes = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length;
    assert.ok(probes <= 12, `1024 first-parent commits use at most logarithmic probes; got ${probes}`);
  } finally {
    process.env.PATH = oldPath;
    if (oldRealGit === undefined) delete process.env.PULLBOARD_REAL_GIT; else process.env.PULLBOARD_REAL_GIT = oldRealGit;
    if (oldCalls === undefined) delete process.env.PULLBOARD_ANCESTRY_CALLS; else process.env.PULLBOARD_ANCESTRY_CALLS = oldCalls;
  }
});
