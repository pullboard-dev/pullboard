/** shadow-batch composes accepted items onto main in a scratch tree and runs the tier-2 checks once, changing nothing [V4,C7]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { main } from '../../tests/fixtures/native.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';

/** Capture the real CLI against the fixture repository. */
async function run(root, args) {
  let stdout = '', stderr = '';
  const code = await main(args, { cwd: root, stdout: { isTTY: false, write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  return { code, stdout, stderr, data: args.includes('--json') ? JSON.parse(stdout) : null };
}

/** A real repository whose main holds the policy, plus a board with two accepted items on disjoint branches. */
function fixture(t, { conflict = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-shadow-batch-test-')));
  const previousHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'private-machine');
  t.after(() => { if (previousHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previousHome; });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => String(runFixtureGit(args, { cwd: root, encoding: 'utf8' })).trim();
  const commit = message => {
    git('add', '-A');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  mkdirSync(join(root, 'web'), { recursive: true });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: { web: { owns: ['web/'] } },
    staticChecks: 'test -f pullboard.json', gate: 'test -f web/a.txt && test -f web/b.txt' }));
  writeFileSync(join(root, 'PRACTICE.md'), '');
  writeFileSync(join(root, 'web/shared.txt'), 'base\n');
  commit('base');
  const heads = [];
  for (const name of ['a', 'b']) {
    runFixtureGit(['switch', '-q', '-c', `item-${name}`, 'main'], { cwd: root, stdio: 'pipe' });
    writeFileSync(join(root, `web/${name}.txt`), `${name}\n`);
    if (conflict) writeFileSync(join(root, 'web/shared.txt'), `${name}\n`);
    heads.push(commit(`feat(web): add ${name} [G1]`));
  }
  runFixtureGit(['switch', '-q', 'main'], { cwd: root, stdio: 'pipe' });
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: root });
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: root });
  const builder = store.register(board, { lane: 'web', path: join(root, 'web') });
  const reviewer = store.register(board, { lane: 'review', path: join(root, 'review') });
  const ids = heads.map((head, index) => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: `Shadow ${index}` });
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze: () => ({ text: `Shadow ${index}`, digest: 'frozen' }) });
    submitFixture(board, id, { agentId: builder, commit: head, tree: git('rev-parse', `${head}^{tree}`) });
    store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', note: 'Fixture accepts.', head, digest: 'frozen', policy: 'any' });
    return id;
  });
  return { root, board, ids, git, events: () => store.events(board).length };
}

test('clause 1: shadow-batch composes two accepted items in a scratch tree and leaves the board and main unchanged [V4,C7]', async t => {
  const f = fixture(t);
  const mainBefore = f.git('rev-parse', 'refs/heads/main'), eventsBefore = f.events();
  const result = await run(f.root, ['shadow-batch', String(f.ids[0]), String(f.ids[1]), '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(result.data.shadowBatch.composed, f.ids);
  assert.equal(f.git('rev-parse', 'refs/heads/main'), mainBefore, 'main did not move');
  assert.equal(f.events(), eventsBefore, 'the board recorded nothing');
  assert.equal(f.git('worktree', 'list').split('\n').length, 1, 'the scratch worktree is gone');
  assert.equal(f.git('status', '--porcelain', '--untracked-files=no'), '', 'the checkout is untouched');
});

test('clause 2: shadow-batch runs the tier-2 checks once and prints wall time and one result per check [V4,C7]', async t => {
  const f = fixture(t);
  const result = await run(f.root, ['shadow-batch', String(f.ids[0]), String(f.ids[1])]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /^static: green in \d+ ms$/mu);
  assert.match(result.stdout, /^gate: green in \d+ ms$/mu, 'the gate sees both items composed');
  assert.match(result.stdout, /^wall time \d+ ms$/mu);
  assert.equal(result.stdout.match(/^(?:static|gate): /gmu).length, 2, 'one result per check');
});

test('a composition conflict names the item and runs no check; a non-accepted item is refused [V4,C7]', async t => {
  const f = fixture(t, { conflict: true });
  const clash = await run(f.root, ['shadow-batch', String(f.ids[0]), String(f.ids[1]), '--json']);
  assert.equal(clash.code, 1);
  assert.equal(clash.data.shadowBatch.conflict, f.ids[1]);
  assert.deepEqual(clash.data.shadowBatch.checks, []);
  const missing = await run(f.root, ['shadow-batch', '99', '--json']);
  assert.notEqual(missing.code, 0);
});
