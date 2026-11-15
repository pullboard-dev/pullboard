/** A pulled gate that moves the runner checkout it judges never settles green: a commit or a tracked edit refuses MOVED_DURING_GATE [V16,C7,P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';

/** The stand-in proof moves its own checkout: a commit when the candidate carries web/commit.txt, else an edit to a tracked file. */
const PROOF = `import { appendFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { record } from './record.js';
record(process.cwd(), 'proof');
if (existsSync('web/commit.txt')) execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', 'chore: moved under the gate']);
else appendFileSync('DOCTRINE.md', 'more\\n');
`;

test('clause 1: a pulled gate whose script commits or edits a tracked file in its runner checkout posts a receipt that is not green, and its item is not submitted [V16,C7,P7]', { timeout: 240_000 }, // budget: hang ceiling for a project, two submits and two whole gates in runner processes.
async t => {
  const box = await pullProject(t, 2, { tooling: { 'bin/proof.js': PROOF } });
  const [edits, commits] = box.ids;
  const candidates = {
    [edits]: submitOne(box, edits).commit,
    [commits]: submitOne(box, commits, { path: 'web/commit.txt', body: 'commit\n', subject: `feat(web): pulled gate ${commits} [G1]` }).commit,
  };
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  const receiptOf = id => jobsOf(board.db, { kind: 'gate', item: id })[0]?.steps.find(step => step.name === 'receipt')?.payload?.receipt ?? null;
  for (let round = 0; round < 4 && !(receiptOf(edits) && receiptOf(commits)); round++) {
    const served = await serveOnce(box, url, `r-moved-${round}`);
    assert.equal(served.code, 0, served.output);
  }
  for (const [moves, id] of [['a tracked file edited during the gate', edits], ['a commit made during the gate', commits]]) {
    const receipt = receiptOf(id);
    assert.ok(receipt, `${moves}: the gate job posted a receipt`);
    assert.notEqual(receipt.gate.green, true, `${moves}: ${JSON.stringify(receipt.gate).slice(0, 4000)}`);
    const moved = receipt.gate.analysis?.refusals?.find(refusal => refusal.code === 'MOVED_DURING_GATE');
    assert.ok(moved, `${moves}: the receipt names MOVED_DURING_GATE: ${JSON.stringify(receipt.gate.analysis?.refusals)}`);
    assert.ok(moved.message.includes(candidates[id].slice(0, 12)), `${moves}: the refusal names the commit the gate was meant to check: ${moved.message}`);
    assert.notEqual(getItem(board, id).item_status, 'submitted', `${moves}: the item is not submitted`);
  }
});
