/** A green pulled gate whose submission another board write overtook is submitted, not recorded as passed but not submitted [C7,#8011]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import * as store from '../../../../store/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';

/**
 * The board seen through a connection on which another real connection commits a write once, between the two
 * snapshot reads of the submission's preparation: the window a busy board's other commands write in while submit seals its reads.
 */
function overtakenOnce(t, board, file) {
  const other = new DatabaseSync(file);
  t.after(() => other.close());
  const state = { armed: false, reads: 0, overtook: 0 };
  const db = new Proxy(board.db, {
    get(target, name) {
      const value = Reflect.get(target, name, target);
      if (name !== 'prepare') return typeof value === 'function' ? value.bind(target) : value;
      return sql => {
        const statement = target.prepare(sql);
        // The second snapshot read inside prepareSubmit is its seal check: the write lands between the two reads.
        if (state.armed && /data_version/u.test(sql) && /prepareSubmit/u.test(String(new Error().stack)) && ++state.reads === 2) {
          state.armed = false; state.overtook += 1;
          other.exec("INSERT OR REPLACE INTO board_meta(meta_key, meta_value) VALUES ('test:overtaken', 'another command wrote')");
        }
        return statement;
      };
    },
  });
  return { view: Object.assign(Object.create(board), { db }), state };
}

test('a green pulled gate is submitted even when another connection writes while its submission is prepared [C7,#8011]', t => {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit;
  const tree = String(runFixtureGit(['rev-parse', `${head}^{tree}`], { cwd: repo.root }).stdout).trim();
  const job = `gate:${item.item_id}:overtaken`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-overtaken', capabilities: [], now: 2 });
  const { view, state } = overtakenOnce(t, board, repo.boardFile);
  state.armed = true;
  const posted = boardJobQueueCall(view, { action: 'receipt', job, runner: 'r-overtaken', token: lease.token,
    receipt: { version: 1, status: 0, gate: { source: head, green: true, phases: [{ role: 'proof', status: 0 }] } } }, { mode: 'pull', now: 3 });
  assert.equal(state.overtook, 1, 'another connection wrote during the apply');
  assert.equal(posted.applied.outcome, 'review', `${JSON.stringify(posted.applied)} ${store.itemThread(board, item.item_id).map(fact => fact.text).join(' | ')}`);
  const after = store.getItem(board, item.item_id);
  assert.equal(after.item_status, 'submitted');
  assert.equal(after.item_commit, head);
  assert.ok(!store.itemThread(board, item.item_id).some(fact => fact.text?.startsWith(`Gate job ${job} passed but not submitted`)));
});
