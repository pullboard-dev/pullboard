/** A gate held by a live auxiliary runner lease renews its progress, so the wait audit files no waits item for it [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { temporaryDirectory } from '../../../board/tests/fixtures/board.js';
import { addItem } from '../../../store/index.js';
import { register } from '../../../store/index.js';
import { shout } from '../../../store/index.js';
import { openWaitKey } from '../../index.js';
import { recordWaits } from '../../index.js';
import { waitBudgets } from '../../index.js';
import { waitItemFields } from '../../index.js';
import { waitsSnapshot } from '../../index.js';

const OWNER = 'pool-51-mill-86cb1a';

test('sentinels.waits-auxiliary-lease.live-lease-files-no-item: gates #6777, #6769 and #6469 held by a live auxiliary lease with progress 5 min old file no waits item [C7]', async t => {
  const board = fixtureBoard(t, { storage: 'file', purpose: 'persistence' });
  const root = temporaryDirectory('pullboard-waits-aux-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const commonDir = join(root, 'repo.git');
  mkdirSync(join(commonDir, 'pullboard'), { recursive: true });
  mkdirSync(join(root, 'home', 'handoff-queue'), { recursive: true });
  const boardFile = board.db.prepare('PRAGMA database_list').get().file;
  const paths = { commonDir, boardFile, machineHome: join(root, 'home'), handoffQueue: join(root, 'home', 'handoff-queue') };
  register(board, { lane: 'coordinator', path: root });
  const now = Date.now();
  const insert = board.db.prepare('INSERT INTO job (job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created, job_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  // Each lease was last renewed 5 minutes ago in effect: the gate's own phases write no step, so only the renewal moves.
  for (const [item, id] of [[6777, 'gate:6777:c6731387a8dd:mwejvbma'], [6769, 'gate:6769:c6731387a8dd:mwejvbmb'], [6469, 'gate:6469:c6731387a8dd:mwejvbmc']]) {
    insert.run(id, 'gate', item, 'proof.running', OWNER, now + 60_000, now - 30 * 60_000, now);
  }
  const snapshot = await waitsSnapshot({ paths, budgets: waitBudgets(), hosts: [], census: new Map(), now });
  const gates = snapshot.rows.filter(entry => entry.surface === 'gate');
  assert.equal(gates.length, 3, 'the audit sees all three gates');
  assert.deepEqual(gates.map(entry => entry.breach), [false, false, false], 'a live lease counts as progress, so none is over gateProgressMs');
  const recorded = await recordWaits(snapshot, {
    openKey: key => openWaitKey(board.db, key),
    fileItem: draft => addItem(board, waitItemFields(draft, 'coordinator')),
    shout: text => shout(board, { from: 'sentinel', to: 'coordinator', lanes: [], text }),
  });
  assert.equal(recorded.filed.length, 0, 'no waits: item is filed for them');
});
