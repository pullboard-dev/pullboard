/** Under gate.runnerDispatch pull a companion submit is gated by one runner job on its composed source, never by the hand-off path [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardJobQueueCall } from '../../../../../packages/api/index.js';
import { jobsOf } from '../../../../../packages/jobs/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { itemThread } from '../../../../../packages/store/index.js';
import { submitHandoff } from '../../../../../packages/store/index.js';
import { pullProject } from '../../../tests/fixtures/pull.js';
import { pullQueue } from '../../../tests/fixtures/pull.js';
import { serveOnce } from '../../../tests/fixtures/pull.js';

/** A companion that adds one file in another lane's folder. */
const COMPANION = 'diff --git a/api/companion.txt b/api/companion.txt\nnew file mode 100644\n--- /dev/null\n+++ b/api/companion.txt\n@@ -0,0 +1 @@\n+companion\n';

/** The text of every fact on an item's thread. */
function facts(board, id) {
  return itemThread(board, id).filter(entry => entry.type === 'fact').map(entry => entry.text ?? entry.fact?.text ?? '').join('\n');
}

test('clause 1: a companion submit under pull offers one gate job on its composed source, writes no hand-off, and the pulled receipt submits it with the companion bound [P7]', { timeout: 180_000 }, // budget: hang ceiling for a project, one submit and one whole gate in a runner process.
async t => {
  const box = await pullProject(t, 1);
  const [id] = box.ids;
  const claimed = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err);
  const folder = JSON.parse(claimed.out).itemFolder ?? box.web;
  assert.equal(box.helpers.commitFile(box, folder, `web/${id}.txt`, 'builder\n', `feat(web): companion pull ${id} [G1]`).status, 0);
  const source = box.git(folder, 'rev-parse', 'HEAD');
  const patch = join(box.dir, 'companion.patch');
  writeFileSync(patch, COMPANION);
  const attached = box.run(box.repo, 'patch', 'attach', String(id), patch, '--key', 'api-side', '--author', 'coordinator', '--source', source, '--json');
  assert.equal(attached.code, 0, attached.err + attached.out);

  const submitted = box.run(folder, 'submit', String(id), '--json');
  assert.equal(submitted.code, 0, `${submitted.err}\n${submitted.out}`);
  const document = JSON.parse(submitted.out);
  assert.equal(document.queued, true, 'the submit returned with its gate queued');
  assert.equal(document.commit, source);
  assert.notEqual(document.composed, source, 'the gate judges the composed source, not the bare builder head');
  assert.equal(box.git(box.repo, 'show', `${document.composed}:api/companion.txt`), 'companion', 'the composed source carries the companion');
  assert.equal(box.git(box.repo, 'rev-parse', `refs/pullboard/gate/${id}`), document.composed, 'runners fetch the composed source');

  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  assert.equal(submitHandoff(board, id), null, 'the companion submit wrote no hand-off');
  const [offered] = jobsOf(board.db, { kind: 'gate', item: id });
  assert.equal(offered.candidate, document.composed);
  assert.equal(offered.id, document.gateJob);

  const served = await serveOnce(box, url, 'r-companion');
  assert.equal(served.code, 0, served.output);
  const [row] = jobsOf(board.db, { kind: 'gate', item: id });
  const { receipt } = row.steps.find(step => step.name === 'receipt').payload;
  assert.equal(receipt.gate.green, true, JSON.stringify(receipt.gate).slice(0, 4000));
  assert.equal(receipt.gate.source, document.composed);
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM job WHERE job_kind <> 'gate'").get().n, 0, 'no dispatcher, driver or worker job exists');
  const item = getItem(board, id);
  assert.deepEqual([item.item_status, item.item_commit], ['submitted', source], facts(board, id));
});
