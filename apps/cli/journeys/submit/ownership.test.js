/** Green foreign paths route through native owner waiting without submitting or losing source [B3,L1,V4]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../tests/fixtures/e2e.js';
import {
  fixtureAdd,
  fixtureJoin,
} from '../../tests/fixtures/testkit.js';
import {
  runFixtureChild,
  runFixtureGit,
  safeFixtureDiagnostic,
} from '../../tests/fixtures/child.js';
import { openBoard } from '../../../lib/index.js';
import {
  closeBoard,
  getItem,
  ownershipWaiting,
  submitHandoff,
  deferOwnership,
} from '../../../../packages/store/index.js';

const BIN = join(import.meta.dirname, '../../pullboard.js');

/** Require actual native command success before interpreting its document. */
function document(result) {
  assert.equal(result.status, 0, [result.failure, result.stderr, safeFixtureDiagnostic(result.stdout)].filter(Boolean).join('\n'));
  return JSON.parse(result.stdout);
}

/** Observe actual persisted state without creating any gate receipt or test authority. */
function observe(box) {
  const board = openBoard(box.file);
  try { return { item: getItem(board, box.id), waiting: ownershipWaiting(board, 'coordinator'), job: submitHandoff(board, box.id) }; }
  finally { closeBoard(board); }
}

/** Build a legitimate historical commit before hooks exist, then join and submit it under current native guards. */
function fixture(t, { gate = 'true', handoff = true } = {}) {
  const helpers = createE2eHelpers();
  let box;
  t.after(async () => {
    try {
      if (box) {
        const job = observe(box).job;
        if (job) await helpers.waitFor(() => { // budget: owned native worker cleanup ceiling, no elapsed-time assertion.
          const state = observe(box);
          return !['queued', 'running'].includes(state.job?.state)
            && !existsSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id, 'source'));
        }, 'the actual private owner gate to finish', 120000); // budget: existing native handoff cleanup ceiling, not a duration assertion.
      }
    } finally { helpers.cleanup(); }
  });
  const isolated = helpers.sandbox();
  const repo = join(isolated.dir, 'owner-repo'), builder = join(isolated.dir, 'owner-builder');
  mkdirSync(repo);
  const env = { ...isolated.env };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  /** Use real Git with the fixture's isolated environment, including normal commit hooks after init. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, encoding: 'utf8' });
  /** Run the candidate CLI only against this private board. */
  const run = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  git(repo, ...['init', '-q', '-b', 'main']); // the repository is the fixture's own, before any hook exists
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate, submit: { handoff },
    verify: { policy: 'any', family: 'off' }, lanes: { web: { owns: ['web/'], specs: ['G1'] } } }));
  writeFileSync(join(repo, 'SPEC.md'), '# Owner fixture\n\n## G · Goals\n- G1 [approved, must] Finished source reaches its owner. | gate: none\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'chore: private initial repository');
  git(repo, 'worktree', 'add', '-q', '-b', 'web/historical', builder);
  mkdirSync(join(builder, 'web'));
  writeFileSync(join(builder, 'web/done.txt'), 'finished\n');
  writeFileSync(join(builder, 'coordinator.txt'), 'owner must inspect this exact change\n');
  git(builder, 'add', '-A'); git(builder, 'commit', '-q', '-m', 'feat: historical finished source');
  // Native init installs the real hooks only now. No hook is disabled, bypassed or removed.
  const initialized = run(repo, 'init');
  assert.equal(initialized.status, 0, initialized.failure || initialized.stderr);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '--allow-empty', '-m', 'chore: initialize owner fixture [G1]');
  const claimBase = git(repo, 'rev-parse', 'HEAD');
  document(fixtureJoin(run, builder, 'web', '--model', FIXTURE_MODEL, '--route', 'strong', '--json'));
  const added = document(fixtureAdd(run, repo, 'web', 'Historical owner candidate', '--specs', 'G1', '--route', 'strong',
    '--criterion', 'The finished web file is present.', '--check', 'test -f web/done.txt',
    '--brief', 'Files: web/done.txt.\nChange: preserve the historical finished source for its owner.\nTest: the real frozen command checks web/done.txt.', '--wait', '--json'));
  const id = added.item.item_id;
  // Freeze the claim at the clean main base, then restore the already-finished historical source.
  git(builder, 'switch', '--detach', claimBase);
  const claimed = document(run(builder, 'claim', String(id), '--json'));
  git(builder, 'switch', 'web/historical');
  box = { repo, builder, root: builder, itemFolder: claimed.itemFolder, env, git, run, id, helpers, file: join(repo, '.git', 'pullboard', 'board.sqlite') };
  return box;
}

test('a green coordinator-owned path waits in its owner next with the exact diff and frees its builder [B3,L1,V4] [clause 1]', async t => {
  const box = fixture(t);
  const acknowledgment = document(box.run(box.root, 'submit', String(box.id), '--no-next', '--json'));
  assert.equal(acknowledgment.queued, true, 'the ordinary captured gate must run');
  await box.helpers.waitFor(() => { // budget: actual native gate completion ceiling, no elapsed-time assertion.
    const current = observe(box);
    if (current.job && !['queued', 'running', 'ownership-wait'].includes(current.job.state)) {
      assert.fail(`native owner gate stopped: ${JSON.stringify(current.job.error ?? current.job)}`);
    }
    return current.job?.state === 'ownership-wait';
  }, 'native ownership result', 120000); // budget: existing native handoff completion ceiling, not a duration assertion.
  const state = observe(box), wait = state.waiting[0];
  assert.equal(state.item.item_status, 'open');
  assert.equal(state.item.item_owner, null, 'the builder has no retained claim');
  assert.equal(state.item.item_commit, null, 'owner waiting is not a submission or approval');
  assert.match(state.item.item_hold_reason, /^waiting on ownership /u);
  assert.deepEqual(wait.paths, ['coordinator.txt']);
  assert.deepEqual(wait.owners, ['coordinator']);
  const diff = runFixtureChild('git', ['diff', '--binary', '--full-index', wait.main, wait.commit, '--', 'coordinator.txt'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(diff.status, 0, diff.failure || diff.stderr);
  assert.equal(wait.diff, diff.stdout, 'the preserved diff keeps its exact bytes, including its final newline');
  assert.equal(box.git(box.root, 'rev-parse', wait.sourceRef).trim(), wait.commit, 'the exact finished source remains pinned');
  const owner = document(box.run(box.repo, 'next', '--build', '--json'));
  assert.equal(owner.action, 'ownership');
  assert.equal(owner.ownershipWaiting[0].item, box.id);
  assert.deepEqual(owner.ownershipWaiting[0].paths, wait.paths);
  assert.equal(owner.ownershipWaiting[0].diff, wait.diff);
  const inbox = document(box.run(box.repo, 'inbox', '--json'));
  const notices = inbox.shouts.filter(shout => shout.shout_text.includes(wait.sourceRef));
  assert.equal(notices.length, 1, 'the owner receives one source-bound notification');
  assert.ok(notices[0].shout_text.includes(wait.diff), 'the notice includes the exact diff');
  const peer = document(fixtureAdd(box.run, box.repo, 'web', 'Next ordinary build', '--specs', 'G1', '--route', 'strong',
    '--criterion', 'The next finished web file is present.', '--check', 'test -f web/done.txt',
    '--brief', 'Files: web/next.txt.\nChange: the freed builder can take ordinary work.\nTest: the next fixture check.', '--wait', '--json'));
  const next = document(box.run(box.builder, 'next', '--build', '--json'));
  assert.equal(next.item.item_id, peer.item.item_id, 'the builder can claim its next ordinary item');
  assert.equal(next.item.item_owner, wait.agentId);
  // Repeating the same native source receipt cannot notify the owner or release another item again.
  const board = openBoard(box.file);
  try {
    const before = board.db.prepare('SELECT COUNT(*) AS n FROM shout').get().n;
    const repeated = deferOwnership(board, box.id, { key: wait.key, root: box.root, agentId: wait.agentId,
      commit: wait.commit, tree: wait.tree, main: wait.main, receiptIds: wait.receiptIds });
    assert.equal(repeated.key, wait.key);
    assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM shout').get().n, before);
  } finally { closeBoard(board); }
});

test('a red gate cannot free its builder or create an owner wait for foreign paths [B3,L1,V4] [clause 1]', t => {
  const box = fixture(t, { gate: 'false', handoff: false });
  const failed = box.run(box.root, 'submit', String(box.id), '--no-next', '--json');
  assert.notEqual(failed.status, 0);
  assert.equal(JSON.parse(failed.stdout).error.code, 'GATE_RED');
  const state = observe(box);
  assert.equal(state.item.item_status, 'claimed');
  assert.notEqual(state.item.item_owner, null);
  assert.deepEqual(state.waiting, [], 'ownership is not a waiver for another red');
  const board = openBoard(box.file);
  try {
    assert.throws(() => deferOwnership(board, box.id, { root: box.root, agentId: state.item.item_owner,
      commit: box.git(box.root, 'rev-parse', 'HEAD').trim(), tree: box.git(box.root, 'rev-parse', 'HEAD^{tree}').trim(),
      main: box.git(box.repo, 'rev-parse', 'HEAD').trim(), receiptIds: ['11111111-1111-4111-8111-111111111111'] }),
    error => error.code === 'PROOF_RUN_UNBOUND');
    assert.deepEqual(ownershipWaiting(board, 'coordinator'), []);
    assert.equal(getItem(board, box.id).item_owner, state.item.item_owner);
  } finally { closeBoard(board); }
});
