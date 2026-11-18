/** Coordinator flow alerts, upgrade notes and shouts reuse the real Git/SQLite statistics and documented thresholds [N32,R1,R2]. */
import { events as readStatsEvents } from '../../../../packages/store/index.js';
import { counterProofStats as readStatsCounter } from '../../../../packages/verify/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { main } from '../../tests/fixtures/native.js';
import { RESUME_HOOK } from '../../index.js';
import { proofStats } from '../../../../packages/stats/index.js';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
import {
  releaseFixture,
  LONG_CHANGELOG,
} from '../../tests/fixtures/resume/release.js';

/** Native read operations explicitly supplied to the statistics under test. */
const statsReadPorts = { events: readStatsEvents, counterProofStats: readStatsCounter };

/** Prove an older agent worktree gets the exact commit-first instruction from its main checkout. */
test('cli.journeys-resume-flow.a-worktree-names-its-main-checkout: a worktree names its main checkout\'s uncommitted init files [I1,I2]', async (t) => {
  const box = releaseFixture(t, { freshSetup: true, historyBeforeInit: true });
  const oldHead = box.git(box.repo, 'rev-parse', 'HEAD');
  const worktree = join(box.root, 'old-agent-worktree');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', worktree, oldHead);

  const fromWorktree = (await box.runLocal(worktree, 'status'));
  assert.equal(fromWorktree.status, 1, fromWorktree.failure || fromWorktree.stderr || fromWorktree.stdout);
  assert.match(fromWorktree.stderr, /main checkout has uncommitted Pullboard setup files/u);
  assert.ok(fromWorktree.stderr.includes(`cd ${box.repo} && git add`), fromWorktree.stderr);
  for (const path of ['pullboard.json', 'SPEC.md', 'DOCTRINE.md']) assert.ok(fromWorktree.stderr.includes(path), fromWorktree.stderr);
  assert.doesNotMatch(fromWorktree.stderr, /worktree <lane>/u);

  const fromMain = (await box.runLocal(box.repo, 'resume', '--diagnostics'));
  assert.equal(fromMain.status, 0, fromMain.failure || fromMain.stderr || fromMain.stdout);
  assert.match(fromMain.stdout, /The person must commit Pullboard's setup files before agents can use worktrees/u);
  assert.ok(fromMain.stdout.includes(`cd ${box.repo} && git add`), fromMain.stdout);
  for (const path of ['pullboard.json', 'SPEC.md', 'DOCTRINE.md']) assert.ok(fromMain.stdout.includes(path), fromMain.stdout);
});

test('cli.journeys-resume-flow.a-first-run-records-the-version: a first run records the version quietly [N19]', t => {
  const box = releaseFixture(t);
  const result = box.run(box.repo, 'resume');
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /new in 0\.8\.[67]|Full release notes/u);
  assert.equal(readFileSync(join(box.repo, '.git', 'pullboard-checkout', 'resume-version'), 'utf8'), '0.8.7\n');
});

test('cli.journeys-resume-flow.resume-limits-long-upgrade-notes-and: resume limits long upgrade notes and skips changelog categories as headlines [N19]', t => {
  const box = releaseFixture(t, { previous: '0.8.3', version: '0.8.9', changelog: LONG_CHANGELOG });
  const result = box.run(box.repo, 'resume');
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const text = result.stdout;
  assert.match(text, /new in 0\.8\.9 — Nine: Nine paragraph\./u);
  assert.match(text, /new in 0\.8\.8 — Eight: Eight paragraph\./u);
  assert.match(text, /new in 0\.8\.7 — Seven: Seven paragraph\./u);
  assert.doesNotMatch(text, /new in 0\.8\.6|new in 0\.8\.5|new in 0\.8\.4/u);
  assert.match(text, /2 earlier releases omitted; see the full notes in CHANGELOG\.md/u);
  assert.doesNotMatch(text, /new in 0\.8\.4 — Added/u);
});

const BASE = Date.parse('2026-10-10T00:00:00Z');
const MINUTE = 60_000;

/** Build native lifecycle moves on a private real board with a deterministic observation clock. */
function fixture(t, { wait = null, age = null, reservation = null, otherAge = null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-resume-flow-')));
  /** Run Git with a private fixture identity and no user configuration. */
  const git = (...args) => runFixtureGit(args, { cwd: root, stdio: 'pipe', env: {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
  } });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', verify: 'any', lanes: { web: { owns: ['web/'] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# Flow fixture\n\n## G · Goals\n- G1 [approved, must] The fixture works. | gate: test\n');
  writeFileSync(join(root, 'DOCTRINE.md'), '# Doctrine\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: create flow fixture');
  const web = join(root, 'builder');
  git('worktree', 'add', '-q', '-b', 'web/one', web);
  let at = 0;
  const clock = { now: () => new Date(BASE + at * MINUTE) };
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), clock);
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: root });
  const builder = store.register(board, { lane: 'web', path: web });
  const reviewer = store.register(board, { lane: 'review', path: join(root, 'reviewer') });
  const freeze = () => ({ text: JSON.stringify({ criterion: 'Flow fixture', rows: [] }), digest: 'frozen' });
  /** Add and submit an item at exact recorded minute offsets. */
  function submit(start, submitted) {
    at = start;
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Flow fixture', criterion: 'Flow fixture' });
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 1000 * MINUTE, freeze });
    at = submitted;
    submitFixture(board, id, { agentId: builder, commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
    return id;
  }
  if (wait !== null) {
    const id = submit(0, 200);
    at = 200 + wait;
    store.reserveReview(board, id, { agentId: reviewer, leaseMs: 1000 * MINUTE, policy: 'any' });
    at += 20;
    store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', note: 'Fixture meets its bar.', head: 'a'.repeat(40), digest: 'frozen', policy: 'any' });
    at = 300;
    store.merged(board, id, { agentId: 'coordinator', commit: 'c'.repeat(40) });
  }
  let waiting = null;
  if (age !== null) {
    waiting = submit(301, 500 - age);
    if (otherAge !== null) submit(311, 500 - otherAge);
    if (reservation !== null) {
      at = 350;
      store.reserveReview(board, waiting, { agentId: reviewer, leaseMs: (reservation === 'live' ? 151 : 150) * MINUTE, policy: 'any' });
      if (reservation === 'released') {
        at = 450;
        store.release(board, waiting, reviewer, 'Fixture releases its review.', 'ROUTED_ELSEWHERE');
      } else if (reservation === 'verdict') {
        at = 450;
        store.verify(board, waiting, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', note: 'Fixture rejection.', clause: 'Flow fixture', head: 'a'.repeat(40), digest: 'frozen', policy: 'any' });
      }
    }
  }
  at = 500;
  /** Run the real command against its native board and capture exact text or JSON. */
  async function run(args, cwd = root) {
    let stdout = '', stderr = '';
    const code = await main(args, { cwd, clock,
      stdout: { isTTY: false, write: text => { stdout += text; } },
      stderr: { write: text => { stderr += text; } } });
    assert.equal(code, 0, stderr || stdout);
    return args.includes('--json') ? JSON.parse(stdout) : stdout.trimEnd();
  }
  return { root, web, waiting, run, board, builder, reviewer, stats: () => proofStats(board, { now: clock.now().getTime() }, statsReadPorts) };
}

/** Require exactly one final line while preserving the ordinary next-step line immediately before it. */
function alert(text, expected) {
  const lines = text.split('\n');
  assert.match(lines.pop(), /^next: \S/u, 'only the appended final action is removed');
  assert.deepEqual(lines.filter(line => line.startsWith('flow:')), [expected]);
  assert.equal(lines.at(-1), expected);
  assert.match(lines.at(-2), /^next: /u);
}

test('cli.journeys-resume-flow.coordinator-resume-ends-with-the-exact: coordinator resume ends with the exact measured-average flow alert [N32,R1,R2]', async t => {
  const box = fixture(t, { wait: 61 });
  alert(await box.run(['resume']), 'flow: review wait average 1 h 1 min (1 measured; > 1 h 0 min); bottleneck: build (66.67% of 5 h 0 min measured cycle time); next: add a builder when open work is available');
  const json = await box.run(['resume', '--json']);
  assert.deepEqual(json.flow, box.stats().flow, 'resume uses precisely the stats observation, stage and action');
  const stats = await box.run(['stats', '--json']);
  assert.deepEqual(json.flow.stages, stats.stats.flow.stages);
  assert.deepEqual(json.flow.bottleneck, stats.stats.flow.bottleneck);
});

test('cli.journeys-resume-flow.coordinator-resume-alerts-for-the-oldest: coordinator resume alerts for the oldest unreviewed submission alone [N32,R1,R2]', async t => {
  const box = fixture(t, { wait: 10, age: 181 });
  alert(await box.run(['resume']), 'flow: unreviewed #2 waiting 3 h 1 min (> 3 h 0 min); bottleneck: build (66.67% of 5 h 0 min measured cycle time); next: add a builder when open work is available');
  assert.deepEqual(box.stats().flow.unreviewed, { size: 1, oldest: { id: 2, since: '2026-10-10T05:19:00.000Z', ageMinutes: 181 } });
});

test('cli.journeys-resume-flow.coordinator-resume-keeps-both-threshold-trips: coordinator resume keeps both threshold trips in one final flow line [N32,R1,R2]', async t => {
  const box = fixture(t, { wait: 61, age: 181 });
  const text = await box.run(['resume']);
  alert(text, 'flow: review wait average 1 h 1 min (1 measured; > 1 h 0 min); unreviewed #2 waiting 3 h 1 min (> 3 h 0 min); bottleneck: build (66.67% of 5 h 0 min measured cycle time); next: add a builder when open work is available');
  const flowLine = text.split('\n').find(line => line.startsWith('flow:'));
  const minuteValues = [...flowLine.matchAll(/(\d+(?:\.\d+)?) min\b/gu)].map(match => Number(match[1]));
  assert.ok(minuteValues.length > 0 && minuteValues.every(value => Number.isInteger(value) && value >= 0 && value < 60),
    `every displayed minute unit is a rounded remainder below 60: ${flowLine}`);
});

test('cli.journeys-resume-flow.coordinator-resume-adds-no-alert-at: coordinator resume adds no alert at exact healthy threshold boundaries [N32,R1,R2]', async t => {
  const box = fixture(t, { wait: 60, age: 180 });
  const text = await box.run(['resume']);
  assert.doesNotMatch(text, /^flow:/mu);
  assert.match(text.split('\n').at(-1), /^next: /u);
});

test('cli.journeys-resume-flow.coordinator-resume-adds-no-alert-to: coordinator resume adds no alert to an unmeasured healthy board [N32,R1,R2]', async t => {
  const box = fixture(t);
  assert.equal(box.stats().flow.bottleneck.stage, null);
  assert.doesNotMatch(await box.run(['resume']), /^flow:/mu);
});

test('cli.journeys-resume-flow.coordinator-resume-names-an-old-waiting: coordinator resume names an old waiting item without inventing a measured bottleneck [N32,R1,R2]', async t => {
  const box = fixture(t, { age: 181 });
  alert(await box.run(['resume']), 'flow: unreviewed #1 waiting 3 h 1 min (> 3 h 0 min); bottleneck: not measured yet');
});

for (const reservation of ['expired', 'released']) {
  test(`coordinator resume counts an ${reservation} review as unreserved from final submit [N32,R1,R2]`, async t => {
    const box = fixture(t, { age: 181, reservation });
    alert(await box.run(['resume']), 'flow: unreviewed #1 waiting 3 h 1 min (> 3 h 0 min); bottleneck: not measured yet');
  });
}

for (const reservation of ['live', 'verdict']) {
  test(`coordinator resume excludes a ${reservation} review from the unreviewed alert [N32,R1,R2]`, async t => {
    const box = fixture(t, { age: 181, reservation });
    assert.deepEqual(box.stats().flow.unreviewed, { size: 0, oldest: null });
    assert.doesNotMatch(await box.run(['resume']), /^flow:/mu);
  });
}

test('cli.journeys-resume-flow.agent-resume-keeps-its-next-step: agent resume keeps its next step without a coordinator flow alert [N32,R1,R2]', async t => {
  const box = fixture(t, { wait: 61, age: 181 });
  const text = await box.run(['resume'], box.web);
  assert.doesNotMatch(text, /^flow:/mu);
  assert.match(text.split('\n').at(-1), /^next: /u);
  assert.equal(Object.hasOwn(await box.run(['resume', '--json'], box.web), 'flow'), false);
});

/** Prove the coordinator's resume counts and names its waiting inbox, privately and read-only. */
test('cli.journeys-resume-flow.resume-shows-the-coordinator-its-unread: resume shows the coordinator its unread shouts [I1,A9]', async t => {
  const box = fixture(t);
  const none = await box.run(['resume']);
  assert.ok(none.split('\n').includes('inbox: 0 unread shouts, 0 open decisions for you'), none);
  assert.match(none.split('\n').at(-1), /^next: (?!read your)/u, 'nothing waiting puts no inbox step first');
  assert.deepEqual((await box.run(['resume', '--json'])).inbox,
    { unread: 0, decisions: 0, newest: [], more: 0, read: 'pullboard inbox' });
  const say = (from, to, text, decision = false) => store.shout(box.board, { from, to, text, lanes: ['web'], decision });
  const first = say(box.builder, 'coordinator', 'Builder asks the coordinator something');
  say(box.builder, box.reviewer, 'Private note for the reviewer alone');
  say(box.reviewer, 'web', 'A note for the web lane alone');
  const second = say(box.reviewer, 'coordinator', 'Which lane owns the docs?\nMore detail below.', true);
  const text = await box.run(['resume']);
  assert.equal(store.unreadCount(box.board, 'coordinator'), 2, 'resume marks nothing read');
  const lines = text.split('\n');
  const at = lines.indexOf('inbox: 2 unread shouts, 1 open decision for you; read them with pullboard inbox');
  assert.ok(at > 0 && lines[at - 1].startsWith('resume: '), `the count opens the card, after its header:\n${text}`);
  assert.doesNotMatch(text, /Private note|for the web lane/u, 'another seat\'s private and lane shouts stay out');
  assert.doesNotMatch(text, /\d+ unread shouts?; newest from/u, 'the old line at the end of the card is not repeated');
  assert.deepEqual(lines.slice(at + 1, at + 3), [
    `  newest #${second} from ${box.reviewer} (unknown) (0m ago): Which lane owns the docs?`,
    `  newest #${first} from ${box.builder} (unknown) (0m ago): Builder asks the coordinator something`,
  ], text);
  assert.equal(lines.at(-1), `next: read your 2 unread shouts first: pullboard inbox; then ${none.split('\n').at(-1).slice('next: '.length)}`);
  const json = await box.run(['resume', '--json']);
  assert.deepEqual(json.inbox, { unread: 2, decisions: 1, more: 0, read: 'pullboard inbox', newest: [
    { id: first, from: box.builder, at: '2026-10-10T08:20:00.000Z', text: 'Builder asks the coordinator something' },
    { id: second, from: box.reviewer, at: '2026-10-10T08:20:00.000Z', text: 'Which lane owns the docs?\nMore detail below.' },
  ] });
  const builderCard = await box.run(['resume', '--json'], box.web);
  assert.equal(Object.hasOwn(builderCard, 'inbox'), false, 'an agent keeps its own unread line');
  assert.equal(builderCard.unread, 1, 'the builder sees its lane, never the coordinator or reviewer shouts');
  assert.equal(builderCard.newest[0].shout_text, 'A note for the web lane alone');
  for (let n = 0; n < 3; n += 1) say(box.builder, 'all', `Board-wide note ${n}`);
  const busy = (await box.run(['resume'])).split('\n');
  const top = busy.findIndex(line => line.startsWith('inbox: '));
  assert.equal(busy[top], 'inbox: 5 unread shouts, 1 open decision for you; read them with pullboard inbox');
  assert.deepEqual(busy.slice(top + 1, top + 5).map(line => line.replace(/#\d+ /u, '')), [
    `  newest from ${box.builder} (unknown) (0m ago): Board-wide note 2`,
    `  newest from ${box.builder} (unknown) (0m ago): Board-wide note 1`,
    `  newest from ${box.builder} (unknown) (0m ago): Board-wide note 0`,
    '  2 more; read them all with pullboard inbox',
  ], 'the newest three by name, then the rest as a count and the command');
  assert.equal(store.inbox(box.board, 'coordinator').length, 5, 'inbox still reads every shout resume showed');
  const read = await box.run(['resume']);
  assert.ok(read.split('\n').includes('inbox: 0 unread shouts, 1 open decision for you; read them with pullboard inbox'), read);
  assert.match(read.split('\n').at(-1), /^next: (?!read your)/u, 'a read inbox no longer goes first');
});

/** Prove the SessionStart hook prints the same inbox count, since it runs pullboard resume. */
test('cli.journeys-resume-flow.resume-shows-the-coordinator-its-unread-2: resume shows the coordinator its unread shouts through the SessionStart hook [I1,A9]', async t => {
  const box = releaseFixture(t);
  const other = join(box.root, 'other-checkout');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: initialize hook inbox fixture [N19]');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'other', other);
  const lane = Object.keys(JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')).lanes)[0];
  const joined = fixtureJoin(box.runLocal, other, lane, '--model', 'Fixture');
  const joinedResult = await joined;
  assert.equal(joinedResult.status, 0, joinedResult.failure || joinedResult.stderr || joinedResult.stdout);
  const shouted = await box.runLocal(other, 'shout', 'coordinator', 'Can the hook show this shout?', '--kind', 'question');
  assert.equal(shouted.status, 0, shouted.failure || shouted.stderr || shouted.stdout);
  // Process-level: the real SessionStart shell hook runs `sh -c` and reaches the copied CLI through PATH.
  const hook = runFixtureChild('sh', ['-c', RESUME_HOOK], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(hook.status, 0, hook.failure || hook.stderr || hook.stdout);
  assert.match(hook.stdout, /^inbox: 1 unread shout, 0 open decisions for you; read them with pullboard inbox$/mu, hook.stdout);
  assert.match(hook.stdout, /^ {2}newest #\d+ from .+ \(\d+m ago\): Can the hook show this shout\?$/mu, hook.stdout);
});


test('cli.journeys-resume-flow.coordinator-resume-finds-the-oldest-unreserved: coordinator resume finds the oldest unreserved item behind an older live review [N32,R1,R2]', async t => {
  const box = fixture(t, { age: 190, otherAge: 181, reservation: 'live' });
  alert(await box.run(['resume']), 'flow: unreviewed #2 waiting 3 h 1 min (> 3 h 0 min); bottleneck: not measured yet');
  assert.deepEqual(box.stats().flow.unreviewed, { size: 1, oldest: { id: 2, since: '2026-10-10T05:19:00.000Z', ageMinutes: 181 } });
});
