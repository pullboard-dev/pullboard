/** The submit-time per-file ratchet follows a file through a rename [D1,D3]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { holdDoctrine } from '../index.js';

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

/** Move the body while retaining a shim, which Git reports as a copy rather than a rename. */
function shimMove(box, shim, body = OLD) {
  mkdirSync(join(box.root, 'web', 'moved'));
  writeFileSync(join(box.root, 'web', 'moved', 'old.html'), body);
  writeFileSync(join(box.root, 'web', 'old.html'), shim);
  return commitAll(box.root, 'refactor: move the page behind a shim');
}

/** A shim must not grant a moved file a larger per-file allowance. */
function refusesMovedGrowth(box, commit, gained, before) {
  assert.throws(() => hold(box, commit), (error) => error.code === 'RATCHET_ROSE'
    && error.message.includes(`web/moved/old.html gains ${gained} problem${gained === 1 ? '' : 's'}, had ${before}`));
}

test('doctrine.rename.a-body-moved-behind-a-re-export-shim: a body moved behind a re-export shim keeps its original problems [D1,D3]', () => {
  for (const shim of [
    "export * from './moved/old.html';\n",
    "/* compatibility */ export { one, two as alias, } from './moved/old.html'; // no body\n",
    "export * as page from './moved/old.html';\nexport { default } from './moved/old.html';\n",
  ]) {
    const box = repo();
    const commit = shimMove(box, shim);
    assert.match(git(box.root, 'diff', '--name-status', '--find-copies', box.main, commit), /C\d+\s+web\/old.html\s+web\/moved\/old.html/u);
    const [result] = hold(box, commit);
    assert.equal(result.count, 4);
    assert.equal(result.holds, true);
  }
});

test('doctrine.rename.a-shim-move-that-gains-a-problem-still: a shim move that gains a problem still refuses below the total ceiling [D1,D3]', () => {
  const box = repo();
  writeFileSync(join(box.root, 'web', 'other.html'), 'done\n');
  const commit = shimMove(box, "export * from './moved/old.html';\n", `${OLD}TODO e\n`);
  refusesMovedGrowth(box, commit, 1, 3);
});

test('doctrine.rename.a-copied-body-whose-origin-remains: a copied body whose origin remains executable gets no inherited allowance [D1,D3]', () => {
  for (const origin of [
    OLD,
    `${OLD}one more harmless line\n`,
    "export * from './moved/old.html';\nexport const executable = 1;\n",
    "export * from './moved/old.html';\nimport './side-effect.js';\n",
    "export * from './moved/old.html';\nconst hidden = '/*'; console.log(hidden); // */\n",
    '',
  ]) {
    const box = repo();
    // Keep the aggregate count below its ceiling even for an actual duplicate.
    const short = OLD.replace('TODO b\nTODO c\n', 'done\ndone\n');
    writeFileSync(join(box.root, 'web', 'other.html'), 'done\n');
    const commit = shimMove(box, origin, short);
    refusesMovedGrowth(box, commit, 1, 0);
  }
});

test('doctrine.rename.a-renamed-file-with-the-same-problems: a renamed file with the same problems passes against its origin [D1,D3]', () => {
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

test('doctrine.rename.a-renamed-file-with-fewer-problems: a renamed file with fewer problems passes [D1,D3]', () => {
  const box = repo();
  mkdirSync(join(box.root, 'web', 'moved'));
  renameSync(join(box.root, 'web', 'old.html'), join(box.root, 'web', 'moved', 'old.html'));
  writeFileSync(join(box.root, 'web', 'moved', 'old.html'), OLD.replace('TODO c\n', 'done\n'));
  const commit = commitAll(box.root, 'refactor: move the page');
  assert.equal(hold(box, commit)[0].count, 3);
});

test('doctrine.rename.a-renamed-file-that-gains-a-problem: a renamed file that gains a problem still refuses (negative control) [D1,D3]', () => {
  const box = repo();
  mkdirSync(join(box.root, 'web', 'moved'));
  renameSync(join(box.root, 'web', 'old.html'), join(box.root, 'web', 'moved', 'old.html'));
  writeFileSync(join(box.root, 'web', 'moved', 'old.html'), `${OLD}TODO e\n`);
  writeFileSync(join(box.root, 'web', 'other.html'), 'done\n');
  const commit = commitAll(box.root, 'refactor: move and grow the page');
  assert.throws(() => hold(box, commit), (error) => error.code === 'RATCHET_ROSE'
    && /web\/moved\/old\.html gains 1 problem, had 3/.test(error.message));
});

test('doctrine.rename.a-genuinely-new-file-with-problems-still: a genuinely new file with problems still refuses (negative control) [D1,D3]', () => {
  const box = repo();
  writeFileSync(join(box.root, 'web', 'fresh.html'), 'TODO x\nTODO y\nTODO z\n');
  writeFileSync(join(box.root, 'web', 'old.html'), 'done\n');
  const commit = commitAll(box.root, 'feat: add a page');
  assert.throws(() => hold(box, commit), (error) => error.code === 'RATCHET_ROSE'
    && /web\/fresh\.html gains 3 problems, had 0/.test(error.message));
});
