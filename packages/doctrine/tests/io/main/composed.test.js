/** The doctrine hold counts the candidate composed with current main, the tree the gate tests, never refusing a moved main alone [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { holdDoctrine } from '../../../index.js';

const roots = [];
const home = mkdtempSync(join(tmpdir(), 'doctrine-composed-home-'));
const previousHome = process.env.PULLBOARD_MACHINE_HOME;
process.env.PULLBOARD_MACHINE_HOME = home;
after(() => {
  for (const root of [...roots, home]) rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
  else process.env.PULLBOARD_MACHINE_HOME = previousHome;
});

// Main's declared count stays 0, as src/view.css's cap problem was absent from the count at 167251144.
const RULE = '- C9 [approved, must] Stylesheets stay under the cap. | gate: check grep -rn OVER src || true | count: 0';
const CSS = 'body { margin: 0; }\na { color: red; }\n';

/** Run Git without hooks or the caller's repository variables; fail with its stderr. */
function git(root, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

/** Stage everything and commit, returning the new commit id. */
function commitAll(root, message) {
  git(root, 'add', '-A', '--', '.');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

/**
 * The item's frozen base has a clean src/view.css; main then gains one problem there without
 * raising its declared count, and may rewrite its doctrine rows. The item is built from the
 * frozen base in its own worktree.
 */
function repo({ mainRules } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'doctrine-composed-'));
  roots.push(dir);
  const root = join(dir, 'main');
  mkdirSync(join(root, 'src'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'DOCTRINE.md'), `## C · Code\n${RULE}\n`);
  writeFileSync(join(root, 'src/view.css'), CSS);
  writeFileSync(join(root, 'src/app.js'), 'export const app = 1;\n');
  const frozen = commitAll(root, 'chore: frozen base');
  writeFileSync(join(root, 'src/view.css'), `${CSS}/* OVER the cap */\n`);
  if (mainRules) writeFileSync(join(root, 'DOCTRINE.md'), `## C · Code\n${mainRules.join('\n')}\n`);
  const main = commitAll(root, 'feat: main grows the stylesheet over the cap');
  const item = join(dir, 'item');
  git(root, 'worktree', 'add', '-q', '-b', 'core/item', item, frozen);
  return { root, item, frozen, main };
}



/** Hold with the main the queued submit captured, as a gate one landing behind does. */
function holdQueued(box, commit) {
  return holdDoctrine(box.item, { mainCommit: git(box.item, 'rev-parse', `${box.main}^`), commit, timeoutMs: 60000 });
}

test('doctrine.io-main-composed.a-candidate-one-landing-behind-main-that: a candidate one landing behind main that merges cleanly passes the hold [C7]', () => {
  const box = repo();
  git(box.item, 'merge', '-q', '--no-edit', `${box.main}^`);
  writeFileSync(join(box.item, 'src/app.js'), 'export const app = 2;\n');
  const commit = commitAll(box.item, 'feat: change the app one landing behind main');
  assert.notEqual(git(box.item, 'merge-base', commit, box.main), box.main, 'the head lacks the newest landing');
  const [result] = holdQueued(box, commit);
  assert.equal(result.holds, true);
  assert.equal(result.count, 1, 'the hold counted the composed tree, which carries main\'s landing');
});

test('doctrine.io-main-composed.a-candidate-one-landing-behind-main-that-2: a candidate one landing behind main that adds a new doctrine problem is still refused [C7]', () => {
  const box = repo();
  writeFileSync(join(box.item, 'src/app.js'), 'export const app = 2; /* OVER here too */\n');
  const commit = commitAll(box.item, 'feat: add a problem one landing behind main');
  assert.throws(() => holdQueued(box, commit), (error) => error.code === 'RATCHET_ROSE' && error.message.includes('src/app.js'));
});

test('doctrine.io-main-composed.only-a-real-merge-conflict-with-current: only a real merge conflict with current main refuses [C7]', () => {
  const box = repo();
  writeFileSync(join(box.item, 'src/view.css'), 'body { margin: 1px; }\n');
  const commit = commitAll(box.item, 'feat: rewrite the stylesheet main also changed');
  assert.throws(() => holdQueued(box, commit), (error) => error.code === 'MERGE_CONFLICT' && error.message.includes(box.main.slice(0, 12)));
});

test('doctrine.io-main-composed.a-behind-candidate-is-composed-even-when: a behind candidate is composed even when the handed baseline is current main [C7]', () => {
  const box = repo();
  writeFileSync(join(box.item, 'src/app.js'), 'export const app = 2;\n');
  const commit = commitAll(box.item, 'feat: change the app behind the handed current main');
  const [result] = holdDoctrine(box.item, { mainCommit: box.main, commit, timeoutMs: 60000 });
  assert.equal(result.holds, true);
  assert.equal(result.count, 1, 'the counted candidate must carry current main problem');
});
