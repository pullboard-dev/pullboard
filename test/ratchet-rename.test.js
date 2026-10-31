/** The submit-time per-file ratchet follows a file through a rename [D1,D3]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { holdDoctrine } from '../packages/doctrine/index.js';

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const RULE = '- Q1 [approved, must] Web pages carry no TODO markers. | gate: check grep -rn TODO web || true | count: 4';
const OLD = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTODO a\nTODO b\nTODO c\n';

function git(root, ...args) {
  const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

/** A repo whose main holds web/old.html with three problems and web/other.html with one. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'ratchet-rename-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'web'));
  writeFileSync(join(root, 'DOCTRINE.md'), `## Q · Quality\n${RULE}\n`);
  writeFileSync(join(root, 'web', 'old.html'), OLD);
  writeFileSync(join(root, 'web', 'other.html'), 'TODO d\n');
  git(root, 'add', '--', 'DOCTRINE.md', 'web');
  git(root, 'commit', '-q', '-m', 'chore: main');
  return { root, main: git(root, 'rev-parse', 'HEAD') };
}

function commitAll(root, message) {
  git(root, 'add', '-A', '--', '.');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function hold({ root, main }, commit) {
  return holdDoctrine(root, { mainCommit: main, commit, timeoutMs: 60000 });
}

test('a renamed file with the same problems passes against its origin [D1,D3]', () => {
  const box = repo();
  mkdirSync(join(box.root, 'web', 'moved'));
  renameSync(join(box.root, 'web', 'old.html'), join(box.root, 'web', 'moved', 'old.html'));
  // One problem fewer elsewhere keeps the total under the count while the new path shows three.
  writeFileSync(join(box.root, 'web', 'other.html'), 'done\n');
  const commit = commitAll(box.root, 'refactor: move the page');
  const [result] = hold(box, commit);
  assert.equal(result.count, 3);
  assert.equal(result.holds, true);
});

test('a renamed file with fewer problems passes [D1,D3]', () => {
  const box = repo();
  mkdirSync(join(box.root, 'web', 'moved'));
  renameSync(join(box.root, 'web', 'old.html'), join(box.root, 'web', 'moved', 'old.html'));
  writeFileSync(join(box.root, 'web', 'moved', 'old.html'), OLD.replace('TODO c\n', 'done\n'));
  const commit = commitAll(box.root, 'refactor: move the page');
  assert.equal(hold(box, commit)[0].count, 3);
});

test('a renamed file that gains a problem still refuses (negative control) [D1,D3]', () => {
  const box = repo();
  mkdirSync(join(box.root, 'web', 'moved'));
  renameSync(join(box.root, 'web', 'old.html'), join(box.root, 'web', 'moved', 'old.html'));
  writeFileSync(join(box.root, 'web', 'moved', 'old.html'), `${OLD}TODO e\n`);
  writeFileSync(join(box.root, 'web', 'other.html'), 'done\n');
  const commit = commitAll(box.root, 'refactor: move and grow the page');
  assert.throws(() => hold(box, commit), (error) => error.code === 'RATCHET_ROSE'
    && /web\/moved\/old\.html gains 1 problem, had 3/.test(error.message));
});

test('a genuinely new file with problems still refuses (negative control) [D1,D3]', () => {
  const box = repo();
  writeFileSync(join(box.root, 'web', 'fresh.html'), 'TODO x\nTODO y\nTODO z\n');
  writeFileSync(join(box.root, 'web', 'old.html'), 'done\n');
  const commit = commitAll(box.root, 'feat: add a page');
  assert.throws(() => hold(box, commit), (error) => error.code === 'RATCHET_ROSE'
    && /web\/fresh\.html gains 3 problems, had 0/.test(error.message));
});
