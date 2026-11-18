/** The doctrine hold's baseline is current main's measured count, run once per main commit and cached machine-wide [C7]. */
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
const home = mkdtempSync(join(tmpdir(), 'doctrine-measured-home-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'doctrine-measured-'));
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

/** Hold an item against the accepted main its submit first saw: the frozen base. */
function hold(box, commit) {
  return holdDoctrine(box.item, { mainCommit: box.frozen, commit, timeoutMs: 60000 });
}

test('doctrine.io-main-baseline.an-item-that-keeps-main-s-over-cap-file: an item that keeps main\'s over-cap file unchanged is held against current main\'s measured count [C7]', () => {
  const box = repo();
  writeFileSync(join(box.item, 'src/app.js'), 'export const app = 2;\n');
  commitAll(box.item, 'feat: change the app');
  git(box.item, 'merge', '-q', '--no-edit', 'main');
  const [result] = hold(box, git(box.item, 'rev-parse', 'HEAD'));
  assert.equal(result.count, 1);
  assert.equal(result.committed, 1, 'the baseline is main\'s measured count, not its declared 0');
  assert.equal(result.holds, true);
});

test('doctrine.io-main-baseline.an-item-that-moves-main-s-over-cap-file: an item that moves main\'s over-cap file is not refused RATCHET_ROSE [C7]', () => {
  const box = repo();
  mkdirSync(join(box.item, 'src/view'));
  git(box.item, 'mv', 'src/view.css', 'src/view/view.css');
  commitAll(box.item, 'refactor: move the stylesheet into its cell');
  git(box.item, 'merge', '-q', '--no-edit', 'main');
  const commit = git(box.item, 'rev-parse', 'HEAD');
  assert.match(git(box.item, 'show', `${commit}:src/view/view.css`), /OVER/u, 'the move carries main\'s problem');
  const [result] = hold(box, commit);
  assert.equal(result.holds, true);
});

test('doctrine.io-main-baseline.an-item-that-adds-a-second-problem-to: an item that adds a second problem to that file is refused RATCHET_ROSE [C7]', () => {
  const box = repo();
  git(box.item, 'merge', '-q', '--no-edit', 'main');
  writeFileSync(join(box.item, 'src/view.css'), `${CSS}/* OVER the cap */\n/* OVER again */\n`);
  const commit = commitAll(box.item, 'feat: grow the stylesheet further');
  assert.throws(() => hold(box, commit), (error) => error.code === 'RATCHET_ROSE'
    && error.message.includes('rose to 2, was 1') && error.message.includes('src/view.css:4:/* OVER again */'));
});

test('doctrine.io-main-baseline.a-second-hold-on-the-same-main-commit: a second hold on the same main commit reads main\'s measured count from the machine-wide cache [C7]', () => {
  const box = repo();
  git(box.item, 'merge', '-q', '--no-edit', 'main');
  writeFileSync(join(box.item, 'src/view.css'), `${CSS}/* OVER the cap */\n/* OVER again */\n`);
  const commit = commitAll(box.item, 'feat: grow the stylesheet further');
  assert.throws(() => hold(box, commit), { code: 'RATCHET_ROSE' });
  const folder = join(home, 'doctrine-main');
  const cached = readdirSync(folder).filter(name => name.endsWith('.json'));
  assert.ok(cached.length >= 1, 'the first hold cached main\'s measured problems');
  // Rewrite every cached main measure: a hold that reads the cache, rather than re-running main, now sees two problems there.
  for (const name of cached) writeFileSync(join(folder, name), JSON.stringify({ problems: ['src/view.css:3:/* OVER the cap */', 'src/view.css:4:/* OVER again */'] }));
  const [result] = hold(box, commit);
  assert.equal(result.committed, 2);
  assert.equal(result.holds, true);
  // Later cases share this main tree; drop the rewritten entries so they measure main again.
  rmSync(folder, { recursive: true, force: true });
});

test('doctrine.io-main-baseline.a-rule-added-on-main-after-the-frozen: a rule added on main after the frozen base holds the item [C7]', () => {
  const box = repo({ mainRules: [RULE, '- C10 [approved, must] Scripts carry no TODO markers. | gate: check grep -rn TODO src || true | count: 0'] });
  git(box.item, 'merge', '-q', '--no-edit', 'main');
  writeFileSync(join(box.item, 'src/app.js'), 'export const app = 2; // TODO\n');
  const commit = commitAll(box.item, 'feat: change the app');
  assert.throws(() => hold(box, commit), (error) => error.code === 'RATCHET_ROSE' && error.message.includes('C10 Scripts carry no TODO markers. rose to 1, was 0'));
});

test('doctrine.io-main-baseline.a-declared-count-above-main-s-measured: a declared count above main\'s measured total never loosens the baseline [C7]', () => {
  const box = repo({ mainRules: [RULE.replace('count: 0', 'count: 2')] });
  writeFileSync(join(box.item, 'src/app.js'), 'export const app = 2;\n');
  commitAll(box.item, 'feat: change the app');
  git(box.item, 'merge', '-q', '--no-edit', 'main');
  const [result] = hold(box, git(box.item, 'rev-parse', 'HEAD'));
  assert.equal(result.count, 1);
  assert.equal(result.committed, 1, 'declared 2, measured 1: the baseline is 1');
  assert.equal(result.holds, true);
});

test('doctrine.io-main-baseline.a-candidate-that-is-exactly-current-main: a candidate that is exactly current main is measured against current main, not the older frozen main it was handed [C7]', () => {
  const box = repo();
  git(box.item, 'merge', '-q', '--ff-only', 'main');
  const [result] = hold(box, box.main);
  assert.equal(result.count, 1);
  assert.equal(result.committed, 1, 'rules and baseline come from current main');
  assert.equal(result.holds, true);
});

test('doctrine.io-main-baseline.a-candidate-that-does-not-contain: a candidate that does not contain current main is composed with it, never refused for that alone [C7]', () => {
  const box = repo();
  writeFileSync(join(box.item, 'src/app.js'), 'export const app = 2;\n');
  const commit = commitAll(box.item, 'feat: change the app without main');
  const [result] = hold(box, commit);
  assert.equal(result.count, 1, 'the composed tree carries main\'s problem');
  assert.equal(result.committed, 1);
  assert.equal(result.holds, true);
});
