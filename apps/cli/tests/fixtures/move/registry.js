/** Real independent SQLite states used by the fixed accepted-main floor snapshot [H3,H16]. */
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { join } from 'node:path';

export const REGISTRY_AT = '2026-10-01T00:00:00.000Z';

/** Recreate only the named private snapshot input; never open an operational board. */
export function registryFixtureBoard(directory, state) {
  const board = openBoard(join(directory, `${state.replaceAll(':', '-')}.sqlite`), { now: () => new Date(REGISTRY_AT) });
  store.register(board, { lane: 'coordinator', path: '/fixture/main' });
  store.register(board, { lane: 'web', path: '/fixture/web' });
  store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Move registry snapshot' });
  if (state === 'bar-ready') store.setBarReady(board, { agentId: 'coordinator', enabled: true });
  if (state === 'outside') board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run('outside:1', JSON.stringify({ source: 'private floor fixture' }));
  if (state.startsWith('batch:')) {
    const kind = state.slice('batch:'.length);
    const batch = { id: 'snapshot-batch', ...(kind === 'trunk' ? { state: 'trunk' } : {}),
      ...(kind === 'environment' ? { environment: { platform: 'darwin', arch: 'arm64', node: '22.13.1' } } : {}),
      ...(kind === 'invariant' ? { invariantEvidence: { fixed: true } } : {}),
      ...(kind === 'reviewed' ? { items: [{ reviewedCommit: 'a'.repeat(40) }] } : {}) };
    store.logEvent(board, 'coordinator', 'landing_batch', null, { batch });
  }
  if (state === 'defects') store.logEvent(board, 'coordinator', 'landing-test-defect', null, { defect: { branch: 'main', test: 'test/fixture.test.js' } });
  if (state === 'first-refusal') store.logEvent(board, 'coordinator', 'reopen', 1, { reopenFirstRefusal: { builder: 'web-1', until: '2026-10-01T02:00:00.000Z' } });
  return board;
}
