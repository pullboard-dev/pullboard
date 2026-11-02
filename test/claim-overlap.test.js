import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimWorktrees, claimOverlapLines } from '../packages/activity/index.js';
import { claimOverlaps, liveClaimCollisions } from '../packages/items/index.js';

test('two claimed Git worktrees name shared edits and protect an open item until release', async t => {
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
  const leftNotice = claimOverlapLines(items, [], 'one', claimOverlaps, observations).join('\n');
  const rightNotice = claimOverlapLines(items, [], 'two', claimOverlaps, observations).join('\n');
  assert.match(leftNotice, /#1 overlaps #2 \(two\) on shared\.js/);
  assert.match(rightNotice, /#2 overlaps #1 \(one\) on shared\.js/);
  assert.match(leftNotice, /#1 may be out of scope: #3 names shared\.js/);
  const { openBoard } = await import('../src/native-board.js');
  const store = await import('../src/board.js');
  const { heartbeatCommand } = await import('../src/cli-presence.js');
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  const left = store.register(board, { lane: 'core', path: first, route: 'strong' });
  const right = store.register(board, { lane: 'core', path: second, route: 'strong' });
  const a = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'First fixture' });
  const b = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Second fixture' });
  const freeze = item => ({ text: JSON.stringify({ title: item.item_title, criterion: 'work', check: 'true', rows: [] }), digest: 'fixture' });
  store.claim(board, a, { agentId: left, lane: 'core', leaseMs: 3600000, head: base, freeze });
  store.claim(board, b, { agentId: right, lane: 'core', leaseMs: 3600000, head: base, freeze });
  for (const [root, id, peer, owner] of [[first, a, b, right], [second, b, a, left]]) {
    const lines = [];
    heartbeatCommand({ err: line => lines.push(line) }, { ctx: { info: { root } }, board });
    assert.match(lines.join('\n'), new RegExp(`#${id} overlaps #${peer} \\(${owner}\\) on shared\\.js`));
  }

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
  store.release(board, edited, holder, 'fixture', undefined, 'ROUTED_ELSEWHERE');
  const offered = store.nextFor(board, { agentId: worker, lane: 'core', workingFiles, omitIds: [edited] });
  assert.equal(offered.item?.item_id, waiting);
});

test('a merged main change is not attributed to the claimed worktree', t => {
  const root = mkdtempSync(join(tmpdir(), 'claim-overlap-main-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git(root, 'init');
  git(root, 'branch', '-m', 'main');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.test');
  writeFileSync(join(root, 'base.js'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const seat = join(root, 'seat');
  git(root, 'worktree', 'add', '--detach', seat, 'HEAD');
  writeFileSync(join(seat, 'own.js'), 'own\n');
  git(seat, 'add', 'own.js');
  git(seat, 'commit', '-m', 'own work');
  writeFileSync(join(root, 'trunk.js'), 'trunk\n');
  git(root, 'add', 'trunk.js');
  git(root, 'commit', '-m', 'trunk work');
  git(seat, 'merge', '--no-edit', 'main');
  const item = { item_id: 1, item_status: 'claimed', item_owner: 'one', item_claim_head: base };
  const observed = claimWorktrees([item], [{ agent_id: 'one', agent_path: seat }]).get(1);
  assert.equal(observed.unknown, false);
  assert.deepEqual(observed.files, ['own.js']);
  git(seat, 'mv', 'base.js', 'renamed.js');
  const renamed = claimWorktrees([item], [{ agent_id: 'one', agent_path: seat }]).get(1);
  assert.deepEqual(renamed.files.toSorted(), ['base.js', 'own.js', 'renamed.js']);
});

test('the real next command routes around a live worktree edit', async t => {
  const { createE2eHelpers } = await import('./e2e-helpers.js');
  const { openBoard } = await import('../src/native-board.js');
  const store = await import('../src/board.js');
  const { mkdirSync } = await import('node:fs');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const second = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', second, 'HEAD');
  const joined = box.run(second, 'join', 'web');
  assert.equal(joined.code, 0, joined.err + joined.out);
  // @pullboard-board-file journey: the CLI and these fixture claims share this private board.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const holder = store.agentAt(board, box.web).agent_id;
  const changed = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Current work' });
  const blocked = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Repair web/shared.js' });
  const free = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Independent work' });
  const base = box.git(box.web, 'rev-parse', 'HEAD').trim();
  store.claim(board, changed, { agentId: holder, lane: 'web', leaseMs: 3600000, head: base,
    freeze: item => ({ text: JSON.stringify({ title: item.item_title, criterion: 'work', check: 'true', rows: [] }), digest: 'fixture' }) });
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'shared.js'), 'work\n');
  const next = box.run(second, 'next', '--build', '--json');
  assert.equal(next.code, 0, next.err + next.out);
  assert.equal(JSON.parse(next.out).item.item_id, free, `#${blocked} must wait while #${changed} edits web/shared.js`);
});
