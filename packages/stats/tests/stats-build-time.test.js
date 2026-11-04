/** @pullboard-test-input source-tree */
/** Private native SQLite histories prove build accounting and the actual CLI report [B35,R1,R2,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as store from '../../store/index.js';
import { openBoard } from '../../../apps/lib/index.js';
import { main } from '../../../test/native-cli-fixture.js';
import { runFixtureGit } from '../../../test/fixture-child.js';
import { TIME_PHASES } from '../index.js';
import { buildTimeStats } from '../index.js';
import { buildTimeLines } from '../index.js';
import { criterionSize } from '../../items/index.js';

const BASE = Date.parse('2026-11-01T00:00:00Z');

/** Preserve known timestamps as imported native events, without presenting them as a runner receipt. */
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-build-time-')));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: { core: { owns: ['src/'] } } }));
  writeFileSync(join(root, 'PRACTICE.md'), '');
  const seed = openBoard(':memory:');
  store.register(seed, { lane: 'coordinator', path: root });
  for (let n = 1; n <= 3; n++) store.addItem(seed, { by: 'coordinator', lane: 'core', title: `Build ${n}`, criterion: 'Change packages/alpha/a.js.' });
  const document = store.exportBoard(seed); store.closeBoard(seed);
  for (const item of document.tables.item) { item.item_status = 'verified'; item.item_merged_commit = 'a'.repeat(40); }
  const rows = [[-1, 'add', 1], [-1, 'add', 2], [-1, 'add', 3], [0, 'claim', 1], [1, 'release', 1], [2, 'claim', 1], [20, 'renew', 1], [22, 'submit', 1], [23, 'merged', 1],
    [0, 'claim', 2], [15, 'submit', 2], [16, 'merged', 2], [30, 'submit', 3], [31, 'merged', 3]];
  document.tables.event = rows.map(([minutes, kind, id], index) => ({ event_id: index + 1, event_at: new Date(BASE + minutes * 60_000).toISOString(),
    event_by: 'coordinator', event_kind: kind, item_id: id, event_detail: '{}' }));
  document.tables.sqlite_sequence.find(row => row.name === 'event').seq = rows.length;
  // @pullboard-board-file persistence: the actual CLI reopens only this private SQLite fixture.
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  store.importBoard(board, document);
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  return { root, board };
}

test('landed build minutes use the last claim, ignore renewals and retain unmeasured evidence [B35,R1,R2,C7]', t => {
  const { board } = fixture(t);
  const report = buildTimeStats(store.events(board), store.listItems(board, { all: true }), [], criterionSize);
  assert.equal(report.items.find(row => row.item === 1).buildMinutes, 20);
  assert.equal(report.items.find(row => row.item === 2).buildMinutes, 15);
  assert.equal(report.items.find(row => row.item === 3).buildMinutes, null);
  assert.deepEqual(report.over15Minutes.map(row => row.item), [1]);
  assert.equal(report.over15Minutes[0].size.score, 3);
  assert.match(buildTimeLines(report).join('\n'), /#1: 20\.00 build minutes.*size 3.*exceeds 15 minutes/u);
});

test('stats time exposes each landed build and its size through the real native CLI [B35,R1,R2,C7]', async t => {
  const { root } = fixture(t); let out = '', err = '';
  const code = await main(['stats', 'time', '--json'], { cwd: root, stdout: { write(text) { out += text; } }, stderr: { write(text) { err += text; } } });
  assert.equal(code, 0, out + err);
  const time = JSON.parse(out).time;
  assert.equal(time.landed, 3, 'the phase report survives alongside build sizes');
  for (const item of time.items) assert.equal(TIME_PHASES.reduce((total, name) => total + item.phases[name], 0), item.clockMs);
  const report = time.builds;
  assert.equal(report.items.length, 3);
  assert.deepEqual(report.over15Minutes.map(row => [row.item, row.buildMinutes, row.size.score]), [[1, 20, 3]]);
});
