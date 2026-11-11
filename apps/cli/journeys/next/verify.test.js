import * as native from '../../../lib/index.js';
/** A reviewer who starts before the builder submits is told the builder is still working [C7,P4]. */
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { main } from '../../tests/fixtures/native.js';
import { loadConfig } from '../../../../packages/config/index.js';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { requireSessionIndependence } from '../../tests/fixtures/testkit.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
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
  box.board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), clock, { gitRoot: root });
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
  // Since 4657576b18 (#2777) next steps never suggest a wait: the step is the same command, not pullboard watch.
  assert.match(said, /next: check pullboard next --verify for a ready review/u, 'the next step checks back with the same command');
  assert.doesNotMatch(said, /pullboard watch/u, 'the next step suggests no wait');
  assert.doesNotMatch(said, /NOTHING_FREE/u, 'no NOTHING_FREE when work is in progress');
  assert.equal(store.getItem(box.board, id).item_review_by, null, 'nothing is reserved');

  submitFixture(box.board, id, { agentId: box.builderId, commit: String(id).padStart(40, 'a'), tree: String(id).padStart(40, 'b') });
  const ready = await run(box, box.reviewer, ['next', '--verify']);
  assert.equal(ready.code, 0, ready.stderr);
  assert.match(ready.stdout, new RegExp(`next to verify: #${id} Being built`, 'u'));
  assert.equal(store.getItem(box.board, id).item_review_by, box.reviewerId, 'a submitted item is reserved as before');
});

test('next --verify with nothing free suggests a command next accepts [C7]', async (t) => {
  const box = await project(t);
  const idle = await run(box, box.reviewer, ['next', '--verify']);
  assert.equal(idle.code, 1);
  const said = idle.stdout + idle.stderr;
  assert.match(said, /NOTHING_FREE/u);
  const suggested = said.match(/To keep looking: pullboard (next[^\n]*)/u);
  assert.ok(suggested, `the refusal names a command: ${said}`);
  assert.doesNotMatch(suggested[1], /--take/u, 'the suggestion never mixes --take with --verify');
  const again = await run(box, box.reviewer, suggested[1].trim().split(/\s+/u));
  assert.doesNotMatch(again.stdout + again.stderr, /USAGE/u, 'next accepts the command it suggested');
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
  const added = fixtureAdd(box.run, box.repo, 'web', 'Ready for review', '--specs', 'G1',
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
    // The fixture model name maps to no tier, so join would default to mid; item #1 needs a strong verifier [V4].
    env: { ...box.env, CODEX_THREAD_ID: 'independent-review-fixture', PULLBOARD_ROUTE: 'strong' }, encoding: 'utf8' });
  assert.equal(independent.status, 0, independent.context);
  assert.match(independent.stdout, /next to verify: #1 Ready for review/u,
    'the printed line reserves the submitted item from the new independent fixture session');
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
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
  const second = store.register(box.board, { lane: 'web', path: join(box.root, 'second-builder'), family: 'Fixture Builder Vendor', parent: 'fixture-parent-P' });
  const outsider = store.register(box.board, { lane: 'review', path: join(box.root, 'outside-reviewer'), family: 'Fixture Reviewer Vendor', parent: 'fixture-parent-Q' });
  const id = claimed(box);
  store.release(box.board, id, box.builderId, 'Return the build claim before another reviewer takes it.', 'OTHER');
  store.claim(box.board, id, { agentId: second, lane: 'web', leaseMs: HOUR,
    freeze: () => ({ text: 'fixture criterion', digest: createHash('sha256').update('fixture criterion').digest('hex') }) });
  submitFixture(box.board, id, { agentId: second, commit: String(id).padStart(40, 'a'), tree: String(id).padStart(40, 'b') });
  requireSessionIndependence(box.reviewer);
  const sibling = await run(box, box.reviewer, ['next', '--verify']);
  assert.equal(sibling.code, 1, sibling.stdout + sibling.stderr);
  assert.equal(store.getItem(box.board, id).item_review_by, null, 'a sibling never reserves its parent’s submission');
  assert.throws(() => store.verify(box.board, id, { agentId: box.reviewerId, decision: 'ACCEPT', policy: 'any' }),
    { code: 'SELF_SESSION_VERIFY' });
  const independent = store.nextFor(box.board, { agentId: outsider, lane: 'review', verify: true, policy: 'any' });
  assert.equal(independent.item.item_id, id, 'another parent can reserve the same submission');
});


test('[V15,C7] idle review cycles open no writer and a newly eligible review reserves exactly once', async t => {
  const box = await project(t);
  const id = claimed(box);
  // The idle reason was already observed: an unchanged poll must not renew its event.
  await run(box, box.reviewer, ['next', '--verify']);
  let writers = 0;
  const before = store.events(box.board).length;
  /** Count real write-capable native connections, while leaving every production guard active. */
  const loadNativeBoard = async () => ({ ...native, openBoard: (...args) => {
    writers++;
    // @pullboard-board-file journey: a spy counts the writers the real command opens on the board file.
    return native.openBoard(...args);
  } });
  /** Poll through the actual native CLI, with its normal reader and reservation authority. */
  const poll = cwd => main(['next', '--verify'], { cwd, clock: box.clock, loadNativeBoard,
    stdout: { isTTY: false, write() {} }, stderr: { write() {} } });
  await poll(box.reviewer);
  await poll(box.reviewer);
  assert.equal(writers, 0, 'unchanged idle cycles never open a write-capable connection');
  assert.equal(store.events(box.board).length, before, 'idle polls append no board events');
  submitFixture(box.board, id, { agentId: box.builderId,
    commit: String(id).padStart(40, 'a'), tree: String(id).padStart(40, 'b') });
  const peer = join(box.root, '..', 'second-reviewer');
  // A second actual worktree competes after the item becomes eligible.
  runFixtureGit(['worktree', 'add', '-q', '--detach', peer, 'HEAD'], { cwd: box.root, encoding: 'utf8' });
  store.register(box.board, { lane: 'review', path: peer, family: 'Fixture Independent Vendor' });
  await Promise.all([poll(box.reviewer), poll(peer)]);
  const reservations = store.events(box.board).filter(event => event.event_kind === 'reserve' && event.item_id === id);
  assert.equal(reservations.length, 1, 'atomic reselection lets exactly one competing reviewer reserve');
  assert.ok(store.getItem(box.board, id).item_review_by);
});

/** Clause 1 of #3206: two idle next --verify polls open zero write-capable board connections. */
test('clause 1: two idle next --verify polls with nothing to review open zero board write connections [V15,C7]', async t => {
  const box = await project(t);
  claimed(box);
  await run(box, box.reviewer, ['next', '--verify']);
  let writers = 0;
  /** Count write-capable native connections while every production guard stays active. */
  const loadNativeBoard = async () => ({ ...native, openBoard: (...args) => {
    writers++;
    // @pullboard-board-file journey: a spy counts the writers the real command opens on the board file.
    return native.openBoard(...args);
  } });
  /** Poll through the actual native CLI. */
  const poll = () => main(['next', '--verify'], { cwd: box.reviewer, clock: box.clock, loadNativeBoard,
    stdout: { isTTY: false, write() {} }, stderr: { write() {} } });
  await poll();
  await poll();
  assert.equal(writers, 0, 'idle polls open no write connection');
});
