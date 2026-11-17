/** The private native-history board shared by the stats comparison cell test and its CLI journey; it launches no CLI [R1,R2,N2]. */
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../../index.js';
import { openBoard } from '../../../../board/tests/fixtures/board.js';
import { NEXT_IDLE_ENGINE } from '../../../../state/light.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';

export const BASE = Date.parse('2026-10-10T00:00:00Z');
/** Exact minute offsets avoid timing margins in every expected interval. */
export function at(minutes) { return new Date(BASE + minutes * 60_000).toISOString(); }
/** A native prospective observation identifies its allocated replay floor. */
export function idle(reason) { return { version: 1, engine: NEXT_IDLE_ENGINE, reason }; }
/** Seed recorded transitions, retaining overlapping seats and a returned-to-open rework interval. */
export function entries() {
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  return [
    [0, 'coordinator', 'add', 1, { lane: 'core' }], [0, 'coordinator', 'add', 3, { lane: 'core' }],
    [0, 'core-1', 'claim', 1, { leaseUntil: at(200) }], [0, 'core-1', 'claim', 3, { leaseUntil: at(200) }],
    [0, 'review-1', 'next-idle', null, idle('review-family')],
    [10, 'core-1', 'submit', 3, { commit: a }], [15, 'core-1', 'submit', 1, { commit: a }],
    [15, 'core-1', 'next-idle', null, idle('held')],
    [20, 'review-1', 'reserve', 3, { until: at(200) }], [25, 'review-1', 'reject', 3, { commit: a }],
    [30, 'review-1', 'reserve', 1, { until: at(200) }],
    [40, 'core-1', 'claim', 3, { leaseUntil: at(200) }], [45, 'review-1', 'accept', 1, { commit: a }],
    [50, 'core-1', 'submit', 3, { commit: b }], [55, 'review-1', 'reserve', 3, { until: at(200) }],
    [58, 'review-1', 'accept', 3, { commit: b }], [59, 'coordinator', 'merged', 3],
    [60, 'coordinator', 'merged', 1],
    [60, 'coordinator', 'add', 2, { lane: 'core' }], [60, 'core-1', 'claim', 2, { leaseUntil: at(200) }],
    [60, 'review-1', 'next-idle', null, idle('main-red')],
    [75, 'core-1', 'submit', 2, { commit: a }], [75, 'core-1', 'next-idle', null, idle('nothing-eligible')],
    [90, 'review-1', 'reserve', 2, { until: at(200) }], [105, 'review-1', 'accept', 2, { commit: a }],
    [105, 'review-1', 'next-idle', null, idle('held')], [120, 'coordinator', 'merged', 2],
    ...[5, 20, 35, 60, 90].map(minute => [minute, 'core-1', 'shout', null, { to: 'coordinator' }]),
    [80, 'core-1', 'shout', null, { to: 'review-1' }],
  ];
}
/** Import only native event rows into a real private board, leaving all mutable item rows open. */
export function fixture(t, changes = entries()) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-stats-compare-')));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: { core: { owns: ['src/'] } } }));
  writeFileSync(join(root, 'PRACTICE.md'), '');
  const clock = { now: () => new Date(at(120)) };
  // @pullboard-board-file persistence: native export/import must preserve real SQLite event history.
  const seed = openBoard(join(root, '.git', 'seed.sqlite'), clock);
  store.register(seed, { lane: 'coordinator', path: root });
  store.register(seed, { lane: 'core', path: join(root, 'builder') });
  store.register(seed, { lane: 'review', path: join(root, 'reviewer') });
  for (let n = 1; n <= 3; n++) store.addItem(seed, { by: 'coordinator', lane: 'core', title: `Window ${n}` });
  const document = store.exportBoard(seed);
  store.closeBoard(seed);
  const joins = document.tables.agent.map(agent => [0, agent.agent_id, 'join', null, { lane: agent.agent_lane }]);
  document.tables.event = [...joins, ...changes].map((entry, order) => ({ entry, order }))
    .sort((a, b) => a.entry[0] - b.entry[0] || a.order - b.order)
    .map(({ entry: [minute, by, kind, id, detail = {}] }, index) => ({ event_id: index + 1,
      event_at: at(minute), event_by: by, event_kind: kind, item_id: id, event_detail: JSON.stringify(detail) }));
  document.tables.sqlite_sequence.find(row => row.name === 'event').seq = document.tables.event.length;
  // @pullboard-board-file journey: the CLI and authenticated API must read the imported private board.
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), clock);
  store.importBoard(board, document);
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  return { root, board, clock, history: () => store.events(board) };
}
