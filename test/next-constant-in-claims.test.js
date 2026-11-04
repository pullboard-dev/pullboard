/** Keep next selection bounded with forty live claims by reading their background observations [H24]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { openBoard } from '../apps/lib/index.js';
import { recordClaimWorktrees, recordedClaimWorktrees } from '../packages/activity/index.js';
import { createE2eHelpers } from './e2e-helpers.js';

const CLAIMS = 40;

/** Freeze fixture items without depending on the repository's live spec. */
function freeze(item) {
  return { text: JSON.stringify({ title: item.item_title, criterion: 'fixture work', check: 'true', rows: [] }), digest: 'fixture' };
}

test('next stays under 200 ms with forty claimed worktrees [H24]', (t) => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const base = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  const agents = store.listAgents(board);
  for (let index = 0; index < CLAIMS; index += 1) {
    const path = join(box.dir, `claimed-${index}`);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
    const agentId = store.register(board, { lane: 'web', path, route: 'strong' });
    const itemId = store.addItem(board, { by: 'coordinator', lane: 'web', title: `Claim ${index}` });
    store.claim(board, itemId, { agentId, lane: 'web', leaseMs: 3_600_000, head: base, freeze });
  }
  const own = agents.find((agent) => agent.agent_path === box.web);
  assert.ok(own, 'the fixture seat is joined to the board');
  store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Available work' });

  recordClaimWorktrees(board, store.listItems(board), store.listAgents(board));
  const items = store.listItems(board);
  const workingFiles = recordedClaimWorktrees(items, store.listAgents(board), board, { own: box.web });
  assert.equal(workingFiles.size, CLAIMS, 'the forty claimed worktrees have recorded observations');
  store.nextFor(board, { agentId: own.agent_id, lane: 'web', workingFiles });
  const started = performance.now();
  const selected = store.nextFor(board, { agentId: own.agent_id, lane: 'web', workingFiles });
  const elapsed = performance.now() - started;
  assert.equal(selected.item?.item_title, 'Available work');
  assert.ok(elapsed < 200, `warm next selection took ${elapsed.toFixed(1)} ms with ${CLAIMS} claims`);
});
