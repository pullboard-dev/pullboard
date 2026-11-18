/** The doctrine's per-file count follows a file the cells path map moved, even where Git detects no rename [D1,C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { holdDoctrine } from '../../../index.js';

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const RULE = '- C9 [approved, must] No source file runs over 1500 lines. | gate: check node cap.js | count: 1';
// The rule's own check, as the file-size check reports: one problem per started 100 lines over the 1500-line cap.
const CAP = "const { execFileSync } = require('node:child_process'); const { readFileSync } = require('node:fs');\n"
  + "for (const file of execFileSync('git', ['ls-files', 'src', 'apps'], { encoding: 'utf8' }).split('\\n').filter(Boolean)) {\n"
  + "  const lines = readFileSync(file, 'utf8').split('\\n').length - 1;\n"
  + "  for (let start = 1501; start <= lines; start += 100) console.log(`${file}:${start}: lines ${start}-${start + 99} are over the 1500-line cap`);\n}\n";
/** Distinct lines, so no two files' contents are similar enough for Git to call a rename. */
const lines = (tag, count) => Array.from({ length: count }, (_, index) => `${tag} ${index}`).join('\n') + '\n';

/** Run Git in the fixture without the machine's hooks or identity. */
function git(root, ...args) {
  const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

/** Main holds a 1561-line src/view.css, already one block over the cap, and a small src/small.css. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'doctrine-path-map-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'DOCTRINE.md'), `## Q · Quality\n${RULE}\n`);
  writeFileSync(join(root, 'cap.js'), CAP);
  writeFileSync(join(root, 'src/view.css'), lines('main view', 1561));
  writeFileSync(join(root, 'src/small.css'), lines('main small', 5));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: main');
  return { root, main: git(root, 'rev-parse', 'HEAD') };
}

/** Move files into the app cell as a cells move does, recording each in the path map, and commit. */
function cellMove(box, moves) {
  mkdirSync(join(box.root, 'apps/view/src/shell'), { recursive: true });
  mkdirSync(join(box.root, 'packages/codemap/data/plan/path-map'), { recursive: true });
  const map = {};
  for (const { from, to, body } of moves) {
    rmSync(join(box.root, from));
    writeFileSync(join(box.root, to), body);
    map[from] = to;
  }
  writeFileSync(join(box.root, 'packages/codemap/data/plan/path-map/view.json'), JSON.stringify(map, null, 2) + '\n');
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'refactor(cells): move the view cell');
  return git(box.root, 'rev-parse', 'HEAD');
}

test('doctrine.io-main-moves.the-1561-line-src-view-css-moved-by-the: the 1561-line src/view.css moved by the cells path map to apps/view/src/shell/view.css keeps the C9 count [D1,C7]', () => {
  const box = repo();
  const commit = cellMove(box, [{ from: 'src/view.css', to: 'apps/view/src/shell/view.css', body: lines('moved view', 1561) }]);
  assert.doesNotMatch(git(box.root, 'diff', '--name-status', '--find-renames', box.main, commit), /^R/mu, 'Git sees no rename');
  const [result] = holdDoctrine(box.root, { mainCommit: box.main, commit, timeoutMs: 60000 });
  assert.equal(result.count, 1);
  assert.equal(result.holds, true);
});

test('doctrine.io-main-moves.growing-the-moved-file-by-100-lines: growing the moved file by 100 lines still raises the C9 count and refuses [D1,C7]', () => {
  const box = repo();
  const commit = cellMove(box, [{ from: 'src/view.css', to: 'apps/view/src/shell/view.css', body: lines('moved view', 1661) }]);
  assert.throws(() => holdDoctrine(box.root, { mainCommit: box.main, commit, timeoutMs: 60000 }),
    error => error.code === 'RATCHET_ROSE' && error.message.includes('rose to 2, was 1') && error.message.includes('apps/view/src/shell/view.css:1601: lines 1601-1700'));
});
