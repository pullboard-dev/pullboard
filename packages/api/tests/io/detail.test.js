/** The item detail keeps an accept fresh when main's only conflict with it is one the mechanical merge resolves, and reads it stale, naming the file, when a real source conflict remains [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fitFile } from '../../../blueprints/index.js';
import { loadConfig } from '../../../config/index.js';
import { mechanicalConflictFiles } from '../../../merge/index.js';
import { repoInfo } from '../../../git/index.js';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { temporaryRepository } from '../../../store/tests/fixtures/submit.js';
import { itemDetailReader } from '../../src/io/detail.js';

const STAMP = '2026-11-16T12:00:00.000Z';
const SHARD = 'packages/codemap/data/plan/14-state.json';
const ROW = n => `["src/m-${n}.js","packages/state/src/m-${n}.js","rule"]`;
const shard = rows => `{\n"order": 8,\n"name": "state",\n"paths": [\n${rows.map(n => ROW(n)).join(',\n')}\n]\n}\n`;

/** Run git in a directory and return trimmed output. */
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** Commit `text` as `file` and return the commit. */
function commitFile(dir, file, text) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', `put ${file}`);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * The detail reader over a repository whose accepted item head and main both changed `file`, with a projector standing in
 * for the verify cell that reports stale exactly when the port it is handed names a file.
 */
function detailOf(t, file, base, ours, theirs, seen = []) {
  const dir = temporaryRepository(t, 'detail-mechanical-');
  commitFile(dir, file, base);
  git(dir, 'checkout', '-q', '-b', 'item');
  const head = commitFile(dir, file, ours);
  git(dir, 'checkout', '-q', 'main');
  commitFile(dir, file, theirs);
  const board = cellBoard(t, ':memory:');
  board.db.prepare("INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'accepted', 'strong', 'open', 'coordinator', ?, ?)").run(STAMP, STAMP);
  const info = repoInfo(dir);
  const projector = (root, _board, { main }, { residualConflicts }) => ({ state: () => {
    seen.push(residualConflicts);
    const left = residualConflicts(root, main, head);
    return left?.length === 0 ? null : { code: 'STALE_VERDICT', file: left?.[0] ?? null };
  } });
  const read = itemDetailReader({
    withReadBoard: (_root, body) => body(board, info), projectItemState: (_board, source) => ({ id: source.item_id }), boardOpeners: null,
    cells: { fitFile, loadConfig, localDependencyIds: () => [], SUMMARY_KEYS: new Set(), verifiedPasskeyRowDecision: () => null,
      projectItemSpecApprovals: base => base, specApprovalState: () => ({}), verdictProjector: projector, typedFieldsEnabled: () => false, hunkFreshnessEnabled: () => false } });
  return read({ root: dir, id: 'detail-fixture' }, 7);
}

test('api.detail.mechanical-conflict-keeps-accept-fresh: clause 1: an accepted item whose only conflict with main is mechanical reports no stale verdict, and one with a real source conflict reports it stale naming the file [C7]', t => {
  const mechanical = detailOf(t, SHARD, shard([1, 2]), shard([1, 2, 3]), shard([1, 2, 4]));
  assert.equal(mechanical.verdictState, undefined, 'two disjoint plan-row appends are a mechanical conflict: no stale verdict');
  const real = detailOf(t, 'src/config.js', 'export const a = 1;\n', 'export const a = 2;\n', 'export const a = 3;\n');
  assert.equal(real.verdictState?.code, 'STALE_VERDICT', 'a real source conflict is stale');
  assert.equal(real.verdictState.file, 'src/config.js', 'the stale state names the file');
});

test('api.detail.mechanical-reader-wired: clause 2: the item detail hands its verdict projector the mechanical conflict reader of the store front door as residualConflicts [C7]', t => {
  const seen = [];
  detailOf(t, SHARD, shard([1, 2]), shard([1, 2, 3]), shard([1, 2, 4]), seen);
  assert.equal(seen.length, 1, 'the projector read one verdict');
  assert.equal(seen[0], mechanicalConflictFiles, 'the port is the mechanical merge reader');
});
