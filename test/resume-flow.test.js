/** Coordinator flow alerts reuse the real Git/SQLite statistics and documented thresholds [N32,R1,R2]. */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { main } from '../src/cli.js';
import { proofStats } from '../src/stats.js';
import { runFixtureGit } from './fixture-child.js';

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
  const board = store.openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), clock);
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: root });
  const builder = store.register(board, { lane: 'web', path: web });
  const reviewer = store.register(board, { lane: 'review', path: join(root, 'reviewer') });
  const freeze = () => ({ text: JSON.stringify({ rows: [] }), digest: 'frozen' });
  /** Add and submit an item at exact recorded minute offsets. */
  function submit(start, submitted) {
    at = start;
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Flow fixture' });
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 1000 * MINUTE, freeze });
    at = submitted;
    store.submit(board, id, { agentId: builder, commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
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
        store.release(board, waiting, reviewer, 'Fixture releases its review.');
      } else if (reservation === 'verdict') {
        at = 450;
        store.verify(board, waiting, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', note: 'Fixture rejection.', head: 'a'.repeat(40), digest: 'frozen', policy: 'any' });
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
  return { root, web, waiting, run, stats: () => proofStats(board, { now: clock.now().getTime() }) };
}

/** Require exactly one final line while preserving the ordinary next-step line immediately before it. */
function alert(text, expected) {
  const lines = text.split('\n');
  assert.deepEqual(lines.filter(line => line.startsWith('flow:')), [expected]);
  assert.equal(lines.at(-1), expected);
  assert.match(lines.at(-2), /^next: /u);
}

test('coordinator resume ends with the exact measured-average flow alert [N32,R1,R2]', async t => {
  const box = fixture(t, { wait: 61 });
  alert(await box.run(['resume']), 'flow: review wait average 61 min (1 measured; > 60 min); bottleneck: build (66.67% of 300 measured cycle min); next: add a builder when open work is available');
  const json = await box.run(['resume', '--json']);
  assert.deepEqual(json.flow, box.stats().flow, 'resume uses precisely the stats observation, stage and action');
  const stats = await box.run(['stats', '--json']);
  assert.deepEqual(json.flow.stages, stats.stats.flow.stages);
  assert.deepEqual(json.flow.bottleneck, stats.stats.flow.bottleneck);
});

test('coordinator resume alerts for the oldest unreviewed submission alone [N32,R1,R2]', async t => {
  const box = fixture(t, { wait: 10, age: 181 });
  alert(await box.run(['resume']), 'flow: unreviewed #2 waiting 181 min (> 180 min); bottleneck: build (66.67% of 300 measured cycle min); next: add a builder when open work is available');
  assert.deepEqual(box.stats().flow.unreviewed, { size: 1, oldest: { id: 2, since: '2026-10-10T05:19:00.000Z', ageMinutes: 181 } });
});

test('coordinator resume keeps both threshold trips in one final flow line [N32,R1,R2]', async t => {
  const box = fixture(t, { wait: 61, age: 181 });
  alert(await box.run(['resume']), 'flow: review wait average 61 min (1 measured; > 60 min); unreviewed #2 waiting 181 min (> 180 min); bottleneck: build (66.67% of 300 measured cycle min); next: add a builder when open work is available');
});

test('coordinator resume adds no alert at exact healthy threshold boundaries [N32,R1,R2]', async t => {
  const box = fixture(t, { wait: 60, age: 180 });
  const text = await box.run(['resume']);
  assert.doesNotMatch(text, /^flow:/mu);
  assert.match(text.split('\n').at(-1), /^next: /u);
});

test('coordinator resume adds no alert to an unmeasured healthy board [N32,R1,R2]', async t => {
  const box = fixture(t);
  assert.equal(box.stats().flow.bottleneck.stage, null);
  assert.doesNotMatch(await box.run(['resume']), /^flow:/mu);
});

test('coordinator resume names an old waiting item without inventing a measured bottleneck [N32,R1,R2]', async t => {
  const box = fixture(t, { age: 181 });
  alert(await box.run(['resume']), 'flow: unreviewed #1 waiting 181 min (> 180 min); bottleneck: not measured yet');
});

for (const reservation of ['expired', 'released']) {
  test(`coordinator resume counts an ${reservation} review as unreserved from final submit [N32,R1,R2]`, async t => {
    const box = fixture(t, { age: 181, reservation });
    alert(await box.run(['resume']), 'flow: unreviewed #1 waiting 181 min (> 180 min); bottleneck: not measured yet');
  });
}

for (const reservation of ['live', 'verdict']) {
  test(`coordinator resume excludes a ${reservation} review from the unreviewed alert [N32,R1,R2]`, async t => {
    const box = fixture(t, { age: 181, reservation });
    assert.deepEqual(box.stats().flow.unreviewed, { size: 0, oldest: null });
    assert.doesNotMatch(await box.run(['resume']), /^flow:/mu);
  });
}

test('agent resume keeps its next step without a coordinator flow alert [N32,R1,R2]', async t => {
  const box = fixture(t, { wait: 61, age: 181 });
  const text = await box.run(['resume'], box.web);
  assert.doesNotMatch(text, /^flow:/mu);
  assert.match(text.split('\n').at(-1), /^next: /u);
  assert.equal(Object.hasOwn(await box.run(['resume', '--json'], box.web), 'flow'), false);
});

test('coordinator resume finds the oldest unreserved item behind an older live review [N32,R1,R2]', async t => {
  const box = fixture(t, { age: 190, otherAge: 181, reservation: 'live' });
  alert(await box.run(['resume']), 'flow: unreviewed #2 waiting 181 min (> 180 min); bottleneck: not measured yet');
  assert.deepEqual(box.stats().flow.unreviewed, { size: 1, oldest: { id: 2, since: '2026-10-10T05:19:00.000Z', ageMinutes: 181 } });
});
