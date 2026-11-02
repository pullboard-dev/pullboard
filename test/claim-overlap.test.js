import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimWorktrees } from '../packages/activity/index.js';
import { claimOverlaps, liveClaimCollisions } from '../packages/items/index.js';

test('two claimed Git worktrees name shared edits and protect an open item until release', t => {
  const root = mkdtempSync(join(tmpdir(), 'claim-overlap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  writeFileSync(join(root, 'shared.js'), 'old\n');
  git('add', '.');
  git('commit', '-m', 'base');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const first = join(root, 'first');
  const second = join(root, 'second');
  git('worktree', 'add', '--detach', first, 'HEAD');
  git('worktree', 'add', '--detach', second, 'HEAD');
  writeFileSync(join(first, 'shared.js'), 'first\n');
  writeFileSync(join(second, 'shared.js'), 'second\n');
  const items = [
    { item_id: 1, item_status: 'claimed', item_owner: 'one', item_claim_head: base, item_criterion: 'Change one thing.' },
    { item_id: 2, item_status: 'claimed', item_owner: 'two', item_claim_head: base, item_criterion: 'Change another thing.' },
    { item_id: 3, item_status: 'open', item_criterion: 'Repair shared.js.' },
  ];
  const observations = claimWorktrees(items, [{ agent_id: 'one', agent_path: first }, { agent_id: 'two', agent_path: second }]);
  const notices = claimOverlaps(items, observations);
  assert.deepEqual(notices.get(1).overlaps, [{ item: 2, builder: 'two', files: ['shared.js'] }]);
  assert.deepEqual(notices.get(2).overlaps, [{ item: 1, builder: 'one', files: ['shared.js'] }]);
  assert.deepEqual(notices.get(1).outOfScope, [{ item: 3, files: ['shared.js'] }]);
  assert.match(liveClaimCollisions(items[2], items, observations).join('\n'), /#3 waits for #1 \(one\) on shared\.js/);
  assert.deepEqual(liveClaimCollisions(items[2], [items[2]], observations), []);
});

test('next skips a named file being edited and offers it after release', async t => {
  const { openBoard } = await import('../src/native-board.js');
  const store = await import('../src/board.js');
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  const holder = store.register(board, { lane: 'core', path: '/tmp/overlap-holder', route: 'strong' });
  const worker = store.register(board, { lane: 'core', path: '/tmp/overlap-worker', route: 'strong' });
  const edited = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Edit unrelated task' });
  const waiting = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Repair shared.js' });
  store.claim(board, edited, { agentId: holder, lane: 'core', leaseMs: 3600000,
    freeze: item => ({ text: JSON.stringify({ title: item.item_title, criterion: 'work', check: 'true', rows: [] }), digest: 'fixture' }) });
  const workingFiles = new Map([[edited, { files: ['shared.js'], unknown: false }]]);
  const blocked = store.nextFor(board, { agentId: worker, lane: 'core', workingFiles });
  assert.notEqual(blocked.item?.item_id, waiting);
  assert.ok(blocked.reasons.some(reason => reason.includes(`#${edited}`) && reason.includes('shared.js')));
  store.release(board, edited, { agentId: holder, reason: 'ROUTED_ELSEWHERE', note: 'fixture' });
  const offered = store.nextFor(board, { agentId: worker, lane: 'core', workingFiles });
  assert.equal(offered.item?.item_id, waiting);
});
