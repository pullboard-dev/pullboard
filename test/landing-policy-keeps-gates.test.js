/** Policy sealing distinguishes landing scheduling from the proof a queued gate owes [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard, closeBoard } from '../apps/lib/index.js';
import { sealClauseInspection } from '../packages/store/index.js';
import { submitUntilSettled } from '../apps/lib/src/shell/submit-infra-requeue.js';
import { runFixtureGit } from './fixture-child.js';

/** Commit actual accepted policy changes in a private Git repo and use its real file board. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-landing-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  /** Run Git only in the owned fixture repo. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env }).trim();
  git('init', '-q', '-b', 'main');
  /** Advance accepted main using the exact serialized policy, without mutating a receipt. */
  const commit = config => {
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify(config));
    git('add', 'pullboard.json');
    git('commit', '-qm', 'chore: fixture policy');
    return git('rev-parse', 'HEAD');
  };
  const initial = commit({});
  mkdirSync(join(root, '.git/pullboard'), { recursive: true });
  const board = openBoard(join(root, '.git/pullboard/board.sqlite'));
  t.after(() => closeBoard(board));
  const options = { agentId: 'fixture', policyCommit: initial, commit: initial, tree: git('rev-parse', 'HEAD^{tree}') };
  return { board, commit, initial, options };
}

for (const phase of ['queued', 'running']) test(`a ${phase} submit retains its sealed proof after landing-only policy changes [C7,V4]`, t => {
  const f = fixture(t);
  const original = sealClauseInspection(f.board, 1, f.options);
  f.commit({ landing: { manualOverride: true, cadence: '1s' } });
  assert.deepEqual(sealClauseInspection(f.board, 1, f.options), original,
    'landing scheduling leaves captured policy provenance and inspection authority unchanged');
  f.commit({ landing: { manualOverride: false, cadence: '2s' } });
  assert.deepEqual(sealClauseInspection(f.board, 1, f.options), original);
});

for (const policy of [{ gate: 'false' }, { check: { timeout: '2s' } }]) test(`changed ${Object.keys(policy)[0]} policy requeues a captured submit and never becomes a test red [C7,V4]`, async t => {
  const f = fixture(t);
  sealClauseInspection(f.board, 1, f.options);
  f.commit(policy);
  let attempts = 0;
  const notices = [];
  await assert.rejects(submitUntilSettled(async () => {
    attempts++;
    return sealClauseInspection(f.board, 1, f.options);
  }, { retries: 1, healthy: async () => true, wait: async () => {}, say: line => notices.push(line) }),
  { code: 'GATE_INFRA_EXHAUSTED' });
  assert.equal(attempts, 2, 'the native worker retry loop requeues the same captured source');
  assert.ok(notices.some(line => line.includes('NO_POLICY') && line.includes('not a red')));
  assert.throws(() => sealClauseInspection(f.board, 1, f.options), { code: 'NO_POLICY' },
    'old evidence never becomes valid under a changed gate/check policy');
});
