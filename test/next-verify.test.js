/** A reviewer who starts before the builder submits is told the builder is still working [C7,P4]. */
import { submitFixture } from './board-submit-fixture.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { main } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';
import { createE2eHelpers } from './e2e-helpers.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const HOUR = 3_600_000;

/** Run the actual CLI in one worktree with the fixture's board clock. */
async function run(box, cwd, args) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { cwd, clock: box.clock,
    stdout: { isTTY: false, write: (part) => { stdout += part; } },
    stderr: { write: (part) => { stderr += part; } } });
  return { code, stdout, stderr };
}

/** A real repo with a builder and a reviewer worktree, each joined to the board. */
async function project(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-next-verify-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(root); mkdirSync(bin);
  // The repo's hooks call pullboard; this private shim runs this checkout's CLI for them.
  /** Quote a literal path for the shim's shell line. */
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, { PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Verify fixture', GIT_AUTHOR_EMAIL: 'verify@example.invalid',
    GIT_COMMITTER_NAME: 'Verify fixture', GIT_COMMITTER_EMAIL: 'verify@example.invalid' });
  /** Git in the fixture, with a synthetic identity and no inherited GIT_* variables. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, stdio: 'pipe', encoding: 'utf8' });
  let at = Date.parse('2026-10-17T12:00:00.000Z');
  const clock = { now: () => new Date(at) };
  const box = { root, clock };
  git(root, 'init', '-q', '-b', 'main');
  const initialized = await run(box, root, ['init']);
  assert.equal(initialized.code, 0, initialized.stderr);
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true',
    lanes: { web: { owns: ['web/'], specs: ['G1'] }, review: { owns: [], specs: ['G1'] } }, shared: [] }));
  writeFileSync(join(root, 'SPEC.md'), '# Verify fixture\n## G\n- G1 [approved, must] Every move keeps its evidence. | gate: true\n');
  writeFileSync(join(root, loadConfig(root).practice), '');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'chore: initialize verify fixture');
  box.builder = join(dir, 'builder'); box.reviewer = join(dir, 'reviewer');
  git(root, 'worktree', 'add', '-q', box.builder, '-b', 'web/one');
  git(root, 'worktree', 'add', '-q', box.reviewer, '-b', 'review/one');
  box.board = store.openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), clock);
  t.after(() => store.closeBoard(box.board));
  box.builderId = store.register(box.board, { lane: 'web', path: box.builder, family: 'Fixture Builder Vendor' });
  box.reviewerId = store.register(box.board, { lane: 'review', path: box.reviewer, family: 'Fixture Reviewer Vendor' });
  return box;
}

/** File an item and have the builder claim it, with a frozen criterion as a real claim has. */
function claimed(box) {
  const id = store.addItem(box.board, { by: 'coordinator', lane: 'web', title: 'Being built', specs: 'G1', criterion: 'The move keeps evidence.', check: 'true' });
  const text = JSON.stringify({ rows: [{ id: 'G1', text: 'Every move keeps its evidence.', gate: 'true' }] });
  store.claim(box.board, id, { agentId: box.builderId, lane: 'web', leaseMs: HOUR,
    freeze: () => ({ text, digest: createHash('sha256').update(text).digest('hex') }) });
  return id;
}

test('[C7,P4] next --verify with nothing submitted yet says the builder is still working', async (t) => {
  const box = await project(t);
  const id = claimed(box);
  const early = await run(box, box.reviewer, ['next', '--verify']);
  assert.equal(early.code, 1, 'nothing is reserved, so the command still exits 1');
  const said = early.stdout + early.stderr;
  assert.match(said, new RegExp(`nothing to review yet; the builder is still working on #${id}`, 'u'));
  assert.match(said, /pullboard watch/u, 'the next step names pullboard watch');
  assert.match(said, /check back: pullboard next --verify/u, 'or check back with the same command');
  assert.doesNotMatch(said, /NOTHING_FREE/u, 'no NOTHING_FREE when work is in progress');
  assert.equal(store.getItem(box.board, id).item_review_by, null, 'nothing is reserved');

  submitFixture(box.board, id, { agentId: box.builderId, commit: String(id).padStart(40, 'a'), tree: String(id).padStart(40, 'b') });
  const ready = await run(box, box.reviewer, ['next', '--verify']);
  assert.equal(ready.code, 0, ready.stderr);
  assert.match(ready.stdout, new RegExp(`next to verify: #${id} Being built`, 'u'));
  assert.equal(store.getItem(box.board, id).item_review_by, box.reviewerId, 'a submitted item is reserved as before');
});

test('a lone newcomer starts a reviewer with one command [V1,B26]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const machine = helpers.sandbox();
  machine.dir = join(machine.dir, "reviewer's board $dollar");
  mkdirSync(machine.dir);
  const box = helpers.project('true', machine);
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.lanes.review = { owns: [] };
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: keep a dedicated reviewer lane');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const model = box.env.PULLBOARD_MODEL;
  delete box.env.PULLBOARD_MODEL;
  const initialized = box.run(box.repo, 'init', '--verbose');
  if (model !== undefined) box.env.PULLBOARD_MODEL = model;
  assert.equal(initialized.code, 0, initialized.err);
  const added = box.run(box.repo, 'add', 'web', 'Ready for review', '--specs', 'G1',
    '--criterion', 'The readiness marker exists.', '--check', 'test -f web/ready');
  assert.equal(added.code, 0, added.err);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const committed = helpers.commitFile(box, box.web, 'web/ready', 'ready\n', 'feat(web): readiness marker [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  const submitted = box.run(box.web, 'submit', '1');
  assert.equal(submitted.code, 0, submitted.err);
  assert.match(submitted.out, /different agent session/iu);
  const startup = submitted.out.split('\n').find(line => line.includes('git worktree add --detach'));
  assert.ok(startup, 'submit prints the complete reviewer startup on one line');
  assert.match(startup, /&&.*pullboard join review.*&&.*pullboard next --verify 1/u);
  assert.equal(initialized.out.split('\n').filter(line => line.includes('git worktree add --detach')).length, 1,
    'init explains the same reviewer path once');
  const mainRefusal = JSON.parse(box.run(box.repo, 'next', '--verify', '1', '--json').out).error;
  assert.equal(mainRefusal.code, 'MAIN_IS_COORDINATOR');
  assert.match(mainRefusal.next, /different agent session/iu);
  assert.match(mainRefusal.next, /git worktree add --detach.*&&.*pullboard join review.*&&.*pullboard next --verify 1/u);
  const self = JSON.parse(box.run(box.web, 'next', '--verify', '1', '--json').out).error;
  assert.equal(self.code, 'SELF_VERIFY', 'the startup guidance does not give the builder a verdict');
  assert.match(startup, /--family "<vendor family>"/u);
  const command = startup.slice(startup.indexOf('cd ')).replaceAll('"<model name>"', "'Independent Reviewer Model'").replaceAll('"<vendor family>"', "'Independent Fixture Reviewer Vendor'");
  const independent = runFixtureChild('/bin/sh', ['-c', command], { cwd: box.repo,
    env: { ...box.env, CODEX_THREAD_ID: 'independent-review-fixture' }, encoding: 'utf8' });
  assert.equal(independent.status, 0, independent.context);
  assert.match(independent.stdout, /next to verify: #1 Ready for review/u,
    'the printed line reserves the submitted item from the new independent fixture session');
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const item = store.getItem(board, 1);
    assert.equal(item.item_status, 'submitted', 'startup reserves a review without writing a verdict');
    assert.notEqual(item.item_review_by, item.item_built_by);
  } finally { store.closeBoard(board); }
});


test('[V1,B3] next never offers a review to a seat sharing a parent with an author', async (t) => {
  const box = await project(t);
  store.register(box.board, { lane: 'web', path: box.builder, parent: 'fixture-parent-P' });
  store.register(box.board, { lane: 'review', path: box.reviewer, parent: 'fixture-parent-P' });
  const second = store.register(box.board, { lane: 'web', path: join(box.root, 'second-builder'), parent: 'fixture-parent-P' });
  const outsider = store.register(box.board, { lane: 'review', path: join(box.root, 'outside-reviewer'), parent: 'fixture-parent-Q' });
  const id = claimed(box);
  store.release(box.board, id, box.builderId);
  store.claim(box.board, id, { agentId: second, lane: 'web', leaseMs: HOUR,
    freeze: () => ({ text: 'fixture criterion', digest: createHash('sha256').update('fixture criterion').digest('hex') }) });
  submitFixture(box.board, id, { agentId: second, commit: String(id).padStart(40, 'a'), tree: String(id).padStart(40, 'b') });
  const sibling = await run(box, box.reviewer, ['next', '--verify']);
  assert.equal(sibling.code, 1, sibling.stdout + sibling.stderr);
  assert.equal(store.getItem(box.board, id).item_review_by, null, 'a sibling never reserves its parent’s submission');
  assert.throws(() => store.verify(box.board, id, { agentId: box.reviewerId, decision: 'ACCEPT', policy: 'any' }),
    { code: 'SELF_SESSION_VERIFY' });
  const independent = store.nextFor(box.board, { agentId: outsider, lane: 'review', verify: true, policy: 'any' });
  assert.equal(independent.item.item_id, id, 'another parent can reserve the same submission');
});
