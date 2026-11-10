/** The private native SQLite history shared by the build-time cell test and its CLI journey; it launches nothing [B35,R1,R2,C7]. */
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as store from '../../../index.js';
import { openBoard } from '../../../../../apps/lib/index.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';

/** Two days back from now: the CLI report's default 7-day window must still hold every landing, whatever day the test runs. */
export const BASE = Math.floor((Date.now() - 2 * 86_400_000) / 60_000) * 60_000;

/** Preserve known timestamps as imported native events, without presenting them as a runner receipt. */
export function fixture(t) {
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
