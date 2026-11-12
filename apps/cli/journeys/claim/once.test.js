/** cleanItemFolders reads the seat once and inspects each item folder with one Git launch [B3,B5,C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/src/logic/native.js';
import { cleanItemFolders } from '../../src/io/item/folder.js';
import { realGitAdapter } from '../../../../packages/git/index.js';
import { withGitContractAdapter } from '../../../../packages/git/index.js';

const ITEMS = 600;

/** Run Git in a fixture repository without inheriting a hook's GIT_* variables. */
function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A real repository and SQLite board with one builder seat, many items and a few of its item folders. */
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-seat-once-')));
  const repo = join(directory, 'seat');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'root');
  const board = openBoard(':memory:');
  t.after(() => { store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: join(directory, 'main') });
  const me = store.register(board, { lane: 'core', path: repo, route: 'mid' });
  const ids = [];
  for (let n = 0; n < ITEMS; n += 1) ids.push(store.addItem(board, { by: 'coordinator', lane: 'core', title: `item ${n}`, criterion: 'prove', specIds: ['B5'], route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves it' }));
  const folder = id => join(directory, `seat-item-${id}`);
  const open = id => { git(repo, 'worktree', 'add', '-q', '-b', `core/item-${id}`, folder(id), 'main'); return folder(id); };
  mkdirSync(join(directory, 'seat-item-notanumber'));
  mkdirSync(join(directory, 'other-item-1'));
  const ctx = { info: { root: repo, commonDir: realpathSync(join(repo, '.git')) } };
  return { board, ctx, me: { id: me, lane: 'core' }, ids, open, folder };
}

/** Run one cleanup while counting seat reads and every Git launch by its arguments. */
function counted(f) {
  const launches = [];
  const prepare = f.board.db.prepare;
  let seatReads = 0;
  f.board.db.prepare = function (sql) {
    if (/FROM agent WHERE agent_id/u.test(sql)) seatReads += 1;
    return prepare.call(this, sql);
  };
  const adapter = {
    spawnSync(args, options) { launches.push(args.join(' ')); return realGitAdapter.spawnSync(args, options); },
    execFileSync(args, options) { launches.push(args.join(' ')); return realGitAdapter.execFileSync(args, options); },
    spawn(args, options) { launches.push(args.join(' ')); return realGitAdapter.spawn(args, options); },
  };
  const started = performance.now();
  try { withGitContractAdapter(adapter, () => cleanItemFolders(f.ctx, f.board, f.me)); }
  finally { f.board.db.prepare = prepare; }
  return { seatReads, launches, ms: performance.now() - started,
    inspections: launches.filter(args => !/ worktree remove | branch -d /u.test(` ${args} `)) };
}

test('[B3,B5,C7] cleanItemFolders reads the seat once and launches at most one Git inspection per item folder', t => {
  const f = fixture(t);
  const clean = [f.ids[1], f.ids[200], f.ids[ITEMS - 1]].map(f.open);
  const dirty = f.open(f.ids[300]);
  writeFileSync(join(dirty, 'draft.txt'), 'keep me\n');
  const held = f.open(f.ids[400]);
  store.claim(f.board, f.ids[400], { agentId: f.me.id, lane: 'core', leaseMs: 7_200_000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'digest:bar' }) });
  const run = counted(f);
  assert.equal(run.seatReads, 1, 'one seat lookup for the whole call');
  assert.ok(run.inspections.length <= 5, `one worktree list plus one status per unheld folder: ${run.inspections.join(' | ')}`);
  assert.equal(run.inspections.filter(args => args.includes('status')).length, 4, 'one status per unheld folder');
  for (const path of clean) assert.equal(existsSync(path), false, `${path} is clean and removed`);
  assert.equal(existsSync(dirty), true, 'uncommitted work is retained');
  assert.equal(existsSync(held), true, 'the live claim keeps its folder');
});

test('[B3,B5,C7] with no item folders cleanup launches no Git and stays under 50 ms over many items', t => {
  const f = fixture(t);
  const run = counted(f);
  assert.equal(run.seatReads, 1);
  assert.deepEqual(run.launches, [], 'no folder, no Git');
  assert.ok(run.ms < 50, `cleanup took ${run.ms.toFixed(1)} ms`);
});

test('[B3,B5,C7] a folder on another branch or repository is left alone', t => {
  const f = fixture(t);
  const path = f.folder(f.ids[5]);
  git(f.ctx.info.root, 'worktree', 'add', '-q', '-b', 'core/elsewhere', path, 'main');
  const stranger = f.folder(f.ids[6]);
  mkdirSync(stranger);
  git(stranger, 'init', '-q', '-b', `core/item-${f.ids[6]}`);
  const run = counted(f);
  assert.equal(run.inspections.length, 1, `only the worktree list runs: ${run.inspections.join(' | ')}`);
  assert.equal(existsSync(path), true);
  assert.equal(existsSync(stranger), true);
});

test('[B3,B5,C7] a dangling item-folder link is skipped without throwing or a per-folder Git inspection', t => {
  const f = fixture(t);
  const dangling = f.folder(f.ids[7]);
  symlinkSync(join(dangling, '..', 'missing-target'), dangling);
  const kept = f.open(f.ids[8]);
  writeFileSync(join(kept, 'draft.txt'), 'keep me\n');
  const run = counted(f);
  assert.equal(run.inspections.filter(args => args.includes('status')).length, 1, `only the real folder gets a status: ${run.inspections.join(' | ')}`);
  assert.equal(run.inspections.length, 2, 'one worktree list and one status');
  assert.equal(existsSync(kept), true);
});
