/** A worktree behind the main checkout runs the main checkout's CLI, hooks included [B17,B3,B34]. */
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { register } from '../../../../packages/store/index.js';
import {
  closeBoard,
  openBoard,
} from '../../../lib/index.js';
import { main } from '../../tests/fixtures/native.js';
import { loadConfig } from '../../../../packages/config/index.js';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';

// Process-level by nature, so every box.run below stays a real process (9 launches, no in-process form exists):
// each one starts a copied CLI entry (or its pre-commit hook launcher) to prove that entry's own start-up,
// stale-worktree handover and PULLBOARD_OWN_CLI behaviour, which runCliInProcess and box.runLocal skip by calling main() directly.
const SOURCE = resolve(import.meta.dirname, '../../../..');
const MAIN_MARK = 'fixture-main-cli-ran';
const OWN_MARK = 'fixture-worktree-cli-ran';
const ENTRY_FILES = ['apps/cli/pullboard.js', 'apps/cli/src/io/current.js', 'apps/cli/src/io/hook/composed.js', 'apps/cli/src/io/resident/client.js', 'apps/cli/src/io/ports/process.js', 'apps/cli/src/io/resident/board.js', 'apps/cli/src/io/resident/socket.js'];

/** Put a stderr marker as the entry's first statement, so a run counts each start of that entry. */
function mark(entry, text) {
  const [shebang, ...rest] = readFileSync(entry, 'utf8').split('\n');
  writeFileSync(entry, [shebang, `process.stderr.write(${JSON.stringify(`${text}\n`)});`, ...rest].join('\n'));
}

/** Put a stderr marker right before the entry dispatches, so a run names whose code ran the command. */
function markDispatch(entry, text) {
  const source = readFileSync(entry, 'utf8');
  const at = source.indexOf('process.exitCode = await main(');
  assert.ok(at > 0, 'the entry dispatches through main');
  writeFileSync(entry, `${source.slice(0, at)}process.stderr.write(${JSON.stringify(`${text}\n`)});\n${source.slice(at)}`);
}

/**
 * A real repo holding this checkout's entry, entry hook launchers and its source (linked), with a
 * board, and a joined worktree one commit behind main: main's commit adds only a marker.
 */
async function project(t, { predates = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-current-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, '.githooks'));
  // The entry and its modules retain their source paths in the fixture.
  for (const file of [...ENTRY_FILES, '.githooks/pre-commit', 'package.json']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(SOURCE, file), join(root, file));
  }
  if (predates) {
    // The first commit is the entry as it was before the handover existed.
    const entry = join(root, 'apps/cli/pullboard.js'), source = readFileSync(entry, 'utf8');
    const old = source.replace(/^\/\/ A worktree behind the main checkout[^\n]*\n[^\n]*runCurrentCli[^\n]*\n[^\n]*handed[^\n]*\n/mu, '');
    assert.notEqual(old, source, 'the fixture strips the handover from the entry');
    writeFileSync(entry, old);
    rmSync(join(root, 'apps/cli/src/io/current.js'));
  }
  // The hook launcher runs the staged static checks before the entry, so their folder is linked too.
  function linkRemaining(relative) {
    const destination = join(root, relative);
    if (!existsSync(destination)) return symlinkSync(join(SOURCE, relative), destination);
    if (!statSync(destination).isDirectory()) return;
    for (const name of readdirSync(join(SOURCE, relative))) linkRemaining(join(relative, name));
  }
  for (const folder of ['src', 'packages', 'apps', 'bin/checks']) linkRemaining(folder);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && name !== 'PULLBOARD_OWN_CLI'));
  Object.assign(env, { PULLBOARD_RESIDENT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Current fixture', GIT_AUTHOR_EMAIL: 'current@example.invalid',
    GIT_COMMITTER_NAME: 'Current fixture', GIT_COMMITTER_EMAIL: 'current@example.invalid' });
  /** Git in the fixture, with a synthetic identity and no inherited GIT_* variables. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, stdio: 'pipe', encoding: 'utf8' });
  git(root, 'init', '-q', '-b', 'main');
  const clock = { now: () => new Date('2026-11-02T12:00:00.000Z') };
  const quiet = { write: () => {} };
  assert.equal(await main(['init', '--no-hooks'], { cwd: root, clock, stdout: { isTTY: false, write: () => {} }, stderr: quiet }), 0);
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', lanes: { web: { owns: ['web/'], specs: ['G1'] } }, shared: [] }));
  writeFileSync(join(root, 'SPEC.md'), '# Current fixture\n## G\n- G1 [approved, must] Every move keeps its evidence. | gate: true\n');
  writeFileSync(join(root, loadConfig(root).practice), '');
  // Fixture commits run no board hooks; the test calls the hook launcher itself.
  mkdirSync(join(dir, 'no-hooks'));
  git(root, 'config', 'core.hooksPath', join(dir, 'no-hooks'));
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'chore: initialize current-cli fixture');
  const worktree = join(dir, 'web');
  git(root, 'worktree', 'add', '-q', worktree, '-b', 'web/one');
  // @pullboard-board-file journey: seed the board file the current CLI opens
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), clock, { gitRoot: root });
  const seat = register(board, { lane: 'web', path: worktree, family: 'Fixture Vendor' });
  closeBoard(board);
  /** Main moves one commit ahead: its entry gains a start marker. */
  const advance = () => {
    mark(join(root, 'apps/cli/pullboard.js'), MAIN_MARK);
    git(root, 'commit', '-q', '-am', 'chore: main moves one commit ahead');
  };
  if (predates) {
    for (const file of ['apps/cli/pullboard.js', 'apps/cli/src/io/current.js']) copyFileSync(join(SOURCE, file), join(root, file));
    git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'feat: main gains the handover');
  } else advance();
  /** Run an entry or launcher with cwd and env, as an agent's shell would. */
  const run = (cwd, command, args, extra = {}) => runFixtureChild(command, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  return { root, worktree, seat, git, run, advance };
}

test('[B17,B3,B34] a worktree behind main runs main\'s CLI with its own seat; hooks too; PULLBOARD_OWN_CLI=1 keeps its code', async (t) => {
  const box = await project(t);
  markDispatch(join(box.worktree, 'apps/cli/pullboard.js'), OWN_MARK);
  const entry = join(box.worktree, 'apps/cli/pullboard.js');

  const behind = box.run(box.worktree, process.execPath, [entry, 'whoami']);
  assert.equal(behind.status, 0, behind.context);
  assert.equal(behind.stderr.split(MAIN_MARK).length - 1, 1, `main's code ran exactly once, never re-handing itself over\n${behind.context}`);
  assert.doesNotMatch(behind.stderr, new RegExp(OWN_MARK, 'u'), 'the worktree\'s stale code never ran the command');
  assert.match(behind.stdout, new RegExp(`\\b${box.seat}\\b`, 'u'), 'the seat is still resolved from the worktree');

  const hook = box.run(box.worktree, 'sh', [join(box.worktree, '.githooks', 'pre-commit')]);
  // A self-hosted pre-commit runs the CLI from the staged index (#2593), so it never runs the stale working tree.
  assert.equal(hook.status, 0, hook.context);
  assert.doesNotMatch(hook.stderr, new RegExp(OWN_MARK, 'u'), `the hook never runs the worktree's stale code\n${hook.context}`);

  const own = box.run(box.worktree, process.execPath, [entry, 'whoami'], { PULLBOARD_OWN_CLI: '1' });
  assert.equal(own.status, 0, own.context);
  assert.match(own.stderr, new RegExp(OWN_MARK, 'u'), 'PULLBOARD_OWN_CLI=1 runs the worktree\'s own code');
  assert.doesNotMatch(own.stderr, new RegExp(MAIN_MARK, 'u'));
  assert.match(own.stdout, new RegExp(`\\b${box.seat}\\b`, 'u'));

  box.git(box.worktree, 'checkout', '-q', '--', 'apps/cli/pullboard.js');
  box.git(box.worktree, 'merge', '-q', '--ff-only', 'main');
  markDispatch(entry, OWN_MARK);
  const current = box.run(box.worktree, process.execPath, [entry, 'whoami']);
  assert.equal(current.status, 0, current.context);
  assert.match(current.stderr, new RegExp(OWN_MARK, 'u'), 'a worktree at or ahead of main runs its own code');
  assert.equal(current.stderr.split(MAIN_MARK).length - 1, 1, 'its entry carries main\'s marker once, from its own copy');
});

test('clause 1 [B17,#3164]: the main checkout and a CLI run against another repo keep their own code; another checkout of the same repo never runs stale code', async (t) => {
  const box = await project(t);
  markDispatch(join(box.worktree, 'apps/cli/pullboard.js'), OWN_MARK);
  const fromMain = box.run(box.root, process.execPath, [join(box.root, 'apps/cli/pullboard.js'), 'whoami']);
  assert.equal(fromMain.stderr.split(MAIN_MARK).length - 1, 1, `the main checkout runs its entry once\n${fromMain.context}`);
  // An item folder run with its seat's stale entry: the cwd is another checkout of the same repository.
  const sameRepo = box.run(box.root, process.execPath, [join(box.worktree, 'apps/cli/pullboard.js'), 'whoami']);
  assert.equal(sameRepo.stderr.split(MAIN_MARK).length - 1, 1, `a stale entry run from another checkout of its repo hands off to main's code\n${sameRepo.context}`);
  assert.doesNotMatch(sameRepo.stderr, new RegExp(OWN_MARK, 'u'), 'the stale code never runs the command');
  const other = join(box.root, '..', 'other-repo');
  mkdirSync(other);
  box.git(other, 'init', '-q', '-b', 'main');
  const elsewhere = box.run(other, process.execPath, [join(box.worktree, 'apps/cli/pullboard.js'), '--help']);
  assert.match(elsewhere.stderr, new RegExp(OWN_MARK, 'u'), 'a stale entry run against another repository keeps its own code, as test fixtures do');
  assert.doesNotMatch(elsewhere.stderr, new RegExp(MAIN_MARK, 'u'));
  assert.doesNotMatch(fromMain.stderr + sameRepo.stderr + elsewhere.stderr, /main checkout CLI not found/u, 'no case is a fallback worth a line');
});

test('[B17] a worktree whose main checkout CLI is missing runs its own code and says why in one line', async (t) => {
  const box = await project(t);
  markDispatch(join(box.worktree, 'apps/cli/pullboard.js'), OWN_MARK);
  renameSync(join(box.root, 'apps/cli/pullboard.js'), join(box.root, 'bin/pullboard.js.gone'));
  const missing = box.run(box.worktree, process.execPath, [join(box.worktree, 'apps/cli/pullboard.js'), 'whoami']);
  assert.equal(missing.status, 0, `the command never fails because the handover could not happen\n${missing.context}`);
  assert.match(missing.stderr, new RegExp(OWN_MARK, 'u'), 'the worktree\'s own code ran the command');
  assert.equal(missing.stderr.split('\n').filter(line => line.includes('main checkout CLI not found; running this worktree\'s code')).length, 1, missing.context);
  assert.match(missing.stderr, /pullboard\.js is missing or unreadable/u, 'the line says why');
  assert.match(missing.stdout, new RegExp(`\\b${box.seat}\\b`, 'u'));
});

test('[B17] a worktree made before the handover existed picks it up at its next main merge, then runs main\'s CLI', async (t) => {
  const box = await project(t, { predates: true });
  const entry = join(box.worktree, 'apps/cli/pullboard.js');
  markDispatch(entry, OWN_MARK);
  const old = box.run(box.worktree, process.execPath, [entry, 'whoami']);
  assert.equal(old.status, 0, old.context);
  assert.match(old.stderr, new RegExp(OWN_MARK, 'u'), 'a tree without the change runs its own code, as the ruling allows');

  box.git(box.worktree, 'checkout', '-q', '--', 'apps/cli/pullboard.js');
  box.git(box.worktree, 'merge', '-q', '--ff-only', 'main');
  box.advance();
  markDispatch(entry, OWN_MARK);
  const behind = box.run(box.worktree, process.execPath, [entry, 'whoami']);
  assert.equal(behind.status, 0, behind.context);
  assert.equal(behind.stderr.split(MAIN_MARK).length - 1, 1, `after one main merge, a worktree behind again runs main's code\n${behind.context}`);
  assert.doesNotMatch(behind.stderr, new RegExp(OWN_MARK, 'u'), 'the worktree\'s stale code never ran the command');
  assert.doesNotMatch(behind.stderr, /main checkout CLI not found/u);
  assert.match(behind.stdout, new RegExp(`\\b${box.seat}\\b`, 'u'), 'the seat is still resolved from the worktree');
});
