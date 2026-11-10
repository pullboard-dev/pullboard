/** Actual detached-worker events supply the handoff documentation contract [A5,V4,H16]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from '../e2e.js';
import { openBoard } from '../../../../lib/index.js';
import { events } from '../../../../../packages/store/index.js';
import { submitHandoff } from '../../../../../packages/store/index.js';
import { fixtureAdd } from '../testkit.js';
import {
  removeSandboxes,
  workerGone,
} from '../submit/handoff.js';

/** Require a real ordinary CLI acknowledgement before reading its document. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Run a genuine queued red and observe the separate worker's persisted native event fields. */
export async function submitHandoffEventContract(t) {
  const helpers = createE2eHelpers();
  const sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'Fixture Model';
  sandbox.env.TMPDIR = sandbox.dir; // Keep the worker path canonical on macOS's /var alias.
  const box = helpers.project('true', sandbox);
  let id;
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  /** Read actual cross-process native state; no fabricated source, job or proof is supplied. */
  function read(action) {
    // @pullboard-board-file journey: the detached worker commits events in another process before this observer reads them.
    const board = openBoard(boardFile);
    try { return action(board); } finally { board.db.close(); }
  }
  t.after(async () => {
    await helpers.waitFor(() => { // budget: hang ceiling for observed worker cleanup; no elapsed-time assertion.
      const job = id ? read(board => submitHandoff(board, id)) : null;
      return !job || !existsSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id, 'source'));
    }, 'actual native handoff worker cleanup', 120000);
    // The supervisor still removes its worktree and tool snapshot after the source goes: wait for it to exit, then
    // remove asynchronously, never the shared synchronous rmSync retries that block past the 30 s file-exit ceiling.
    const job = id ? read(board => submitHandoff(board, id)) : null;
    if (job) await workerGone(helpers, box, job.id);
    await removeSandboxes(helpers);
  });
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, submit: { ...config.submit, handoff: true } }) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: native handoff event fixture [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  id = document(fixtureAdd(box.run, box.repo, 'web', 'Real handoff event contract', '--specs', 'G1',
    '--criterion', 'A real failing check returns the captured candidate.', '--check', 'false', '--wait', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  assert.equal(helpers.commitFile(box, box.web, 'web/event-contract.txt', 'captured\n', 'feat(web): native handoff contract [G1]').status, 0);
  assert.equal(document(box.run(box.web, 'submit', String(id), '--no-next', '--json')).queued, true);
  await helpers.waitFor(() => read(board => submitHandoff(board, id))?.state === 'red', 'actual native red result', 120000); // budget: hang ceiling for observed durable worker completion.
  const rows = read(board => events(board, { itemId: id }).filter(row => ['submit-handoff', 'submit_handoff_returned'].includes(row.event_kind)));
  assert.deepEqual([...new Set(rows.map(row => row.event_kind))].sort(), ['submit-handoff', 'submit_handoff_returned']);
  return rows.map(row => ({ ...row, detail: JSON.parse(row.event_detail) }));
}
