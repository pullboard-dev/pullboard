/** Identical refreezes retain real claims; genuine changes and historical replay keep their semantics [V2,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { UNCHANGED_REFREEZE_ENGINE } from '../../../../packages/state/light.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/** Compute actual content identities instead of test-only constant digests. */
function frozen(text = 'Original promise') {
  const source = JSON.stringify({ criterion: text });
  return { text: source, digest: createHash('sha256').update(source).digest('hex') };
}

/** Use real Git and SQLite with a controlled board clock, never the operational board. */
function fixture(t, { legacy = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-unchanged-refreeze-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Refreeze fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Refreeze fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !key.startsWith('GIT_CONFIG_') && !key.startsWith('GIT_AUTHOR_') && !key.startsWith('GIT_COMMITTER_')) delete env[key];
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env, encoding: 'utf8' });
  runFixtureGit(['commit', '--allow-empty', '-q', '-m', 'fixture'], { cwd: root, env, encoding: 'utf8' });
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root, env, encoding: 'utf8' }).trim();
  let now = new Date('2026-10-27T12:00:00Z');
  const board = fixtureBoard(t, { clock: { now: () => new Date(now) } });
  if (legacy) board.executionEngineVersion = UNCHANGED_REFREEZE_ENGINE - 1;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  store.board_ensureCoordinator(board, root);
  const builder = store.register(board, { lane: 'core', path: join(root, 'builder'), model: 'Refreeze fixture builder' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Repeat a refreeze', criterion: 'Original promise' });
  store.claim(board, id, { agentId: builder, lane: 'core', head, leaseMs: 60_000, freeze: () => frozen() });
  return { board, builder, id, expire: () => { now = new Date(now.getTime() + 60_001); } };
}

test('[V2,H16] identical refreezes keep the exact live claim, lease, base and item row', t => {
  const f = fixture(t);
  const before = store.getItem(f.board, f.id);
  for (let repeat = 0; repeat < 3; repeat += 1) {
    const result = store.refreeze(f.board, f.id, { agentId: 'coordinator', freeze: () => frozen() });
    assert.deepEqual(result, { before: before.item_frozen_digest, after: before.item_frozen_digest, retainedClaim: true, unchanged: true });
    assert.deepEqual(store.getItem(f.board, f.id), before, 'no item field or update timestamp is rewritten');
  }
  const last = store.events(f.board).findLast(event => event.event_kind === 'refreeze');
  assert.equal(JSON.parse(last.event_detail).unchanged, true, 'the ordinary event retains observable idempotence');
});

test('[V2,H16] a real bar change reopens; an expired claim is never preserved as live', t => {
  const changed = fixture(t);
  const result = store.refreeze(changed.board, changed.id, { agentId: 'coordinator', freeze: () => frozen('A different promise') });
  assert.equal(result.unchanged, undefined);
  const opened = store.getItem(changed.board, changed.id);
  assert.equal(opened.item_status, 'open'); assert.equal(opened.item_owner, null); assert.equal(opened.item_lease_until, null);
  assert.equal(opened.item_frozen_digest, frozen('A different promise').digest);
  const expired = fixture(t); expired.expire();
  store.refreeze(expired.board, expired.id, { agentId: 'coordinator', freeze: () => frozen() });
  assert.equal(store.getItem(expired.board, expired.id).item_status, 'open');
  assert.equal(store.getItem(expired.board, expired.id).item_owner, null);
});

test('[V2,H16] unchanged detection cannot bypass authority or rewrite old-engine release behavior', t => {
  const f = fixture(t);
  const before = store.getItem(f.board, f.id);
  let called = false;
  assert.throws(() => store.refreeze(f.board, f.id, { agentId: f.builder, freeze: () => { called = true; return frozen(); } }), { code: 'COORDINATOR_ONLY' });
  assert.equal(called, false); assert.deepEqual(store.getItem(f.board, f.id), before);
  const legacy = fixture(t, { legacy: true });
  const result = store.refreeze(legacy.board, legacy.id, { agentId: 'coordinator', freeze: () => frozen() });
  assert.equal(result.unchanged, undefined); assert.equal(result.retainedClaim, undefined);
  assert.equal(store.getItem(legacy.board, legacy.id).item_status, 'open');
});

test('[V2] the actual CLI reports an identical refreeze as retained and preserves the claim', async t => {
  const e2e = createE2eHelpers();
  const box = e2e.project('true');
  t.after(e2e.cleanup);
  const added = (await fixtureAdd(box.runLocal, box.repo, 'web', 'Same frozen bar', '--specs', 'G1', '--route', 'strong', '--criterion', 'The promise stays the same', '--check', 'true', '--json'));
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = (await box.runLocal(box.web, 'claim', String(id), '--json'));
  assert.equal(claimed.code, 0, claimed.err || claimed.out);
  // @pullboard-board-file journey: the actual CLI and this reader share the same durable board
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    const before = store.getItem(board, id);
    const repeated = (await box.runLocal(box.repo, 'refreeze', String(id), '--json'));
    assert.equal(repeated.code, 0, repeated.err || repeated.out);
    assert.equal(JSON.parse(repeated.out).unchanged, true);
    assert.deepEqual(store.getItem(board, id), before);
  } finally { store.closeBoard(board); }
});
