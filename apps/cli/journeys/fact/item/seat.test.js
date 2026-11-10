/** Item custody survives maintenance and missing markers give native recovery guidance [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  openBoard,
  closeBoard,
} from '../../../../lib/index.js';
import * as store from '../../../../../packages/store/index.js';
import { repoInfo } from '../../../../../packages/git/index.js';
import { crossLaneFixture } from '../../../tests/fixtures/e2e.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { runWorktreeMaintenance } from '../../../src/io/worktree/maintenance.js';
import { writeMaintenanceState } from '../../../src/io/worktree/maintenance/observation.js';

/** Open a genuine claimed item in a separate worktree with its native marker. */
function fixture(t) {
  const box = crossLaneFixture(t);
  const seat = box.seat('custody-seat', 'web', box.session);
  const id = box.add('web', 'Retain item custody');
  const claimed = box.json(box.runAs(box.session, seat.root, 'claim', String(id), '--json'));
  const path = claimed.itemFolder;
  const marker = join(repoInfo(path).gitDir, 'pullboard-item.json');
  return { box, seat, id, path, marker };
}

test('claimed and submit-pending item folders retain exact marker bytes during maintenance [C7]', async t => {
  const { box, id, path, marker } = fixture(t);
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  t.after(() => closeBoard(board));
  const bytes = readFileSync(marker);
  const now = Date.now() + 3 * 86400000;
  const config = { worktrees: 'inside', worktreeMaintenance: { enabled: true, every: '1h', grace: '1s', exclude: [] } };
  const ports = { agentId: 'coordinator', workingDirectories: () => [],
    /** Deliberately absent parent presence must not erase an item's independent custody. */
    readSnapshot: async () => ({ seats: store.listAgents(board).map(row => ({ ...row, presence: 'gone' })), items: store.listItems(board, { all: true }) }),
    /** Protected item folders must never reach archival or deletion. */
    recordArchive: async record => { assert.notEqual(record.path, path); },
  };
  for (const phase of ['gate-running', 'submitted']) {
    writeMaintenanceState(repoInfo(box.repo).commonDir, { version: 1, trees: {
      [path]: { firstSeenAt: now - 86400000, inactiveSince: now - 86400000 },
    } });
    const report = await runWorktreeMaintenance(box.repo, config, ports, { now });
    assert.equal(report.entries.find(row => row.path === path).reason, 'item-folder-obligation', phase);
    assert.equal(existsSync(path), true);
    assert.deepEqual(readFileSync(marker), bytes);
    if (phase === 'gate-running') {
      const item = store.getItem(board, id);
      submitFixture(board, id, { agentId: item.item_owner, commit: box.git(path, 'rev-parse', 'HEAD'), tree: box.git(path, 'rev-parse', 'HEAD^{tree}') });
    }
  }
});

test('commit-msg in a missing-marker item folder names the exact native claim renewal [C7]', t => {
  const { box, seat, id, path, marker } = fixture(t);
  writeFileSync(join(path, 'draft.txt'), 'retain this source\n');
  box.json(box.runAs(box.session, seat.root, 'release', String(id), '--reason', 'OTHER', '--note', 'exercise missing marker recovery', '--no-next', '--json'));
  unlinkSync(marker);
  const message = join(box.dir, 'commit-message');
  writeFileSync(message, 'feat(web): retain item [G1]\n');
  const refused = box.runAs(box.session, path, 'hook', 'commit-msg', message, '--json');
  assert.equal(refused.code, 1);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'ITEM_MARKER_MISSING');
  assert.ok(error.message.includes(`pullboard claim ${id}`));
  assert.ok(error.message.includes(seat.root));
  assert.equal(existsSync(marker), false, 'guidance grants no authority to a released item');
});
