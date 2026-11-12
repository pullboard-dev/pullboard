/** Pull landing end to end: the automatic lander offers a land job, runner serve merges and pushes trunk, and the receipt marks the item merged [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardJobQueueCall } from '../../../../../packages/api/index.js';
import { jobsOf } from '../../../../../packages/jobs/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { landingBatches } from '../../../../../packages/store/index.js';
import { verify } from '../../../../../packages/store/index.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { pullProject } from '../../../tests/fixtures/pull.js';
import { pullQueue } from '../../../tests/fixtures/pull.js';
import { serveOnce } from '../../../tests/fixtures/pull.js';
import { submitOne } from '../../../tests/fixtures/pull.js';

/** Run the automatic lander's own entry, as a landing wake does, in a child process at the main checkout. */
function landAfterAccept(box) {
  const source = [
    `import { wakeIo } from ${JSON.stringify(new URL('../../../src/io/landing/automatic.js', import.meta.url).href)};`,
    `import { context, landAfterAcceptance } from ${JSON.stringify(new URL('../../../index.js', import.meta.url).href)};`,
    'console.log("RESULT " + JSON.stringify(await landAfterAcceptance(context(wakeIo(process.argv[1])))));',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo], { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.split('\n').find(line => line.startsWith('RESULT ')).slice(7));
}

/** A pull project whose main names a bare trunk remote of record, with one item accepted after its pulled gate went green. */
async function acceptedOnPull(t) {
  const box = await pullProject(t, 1);
  const trunk = join(box.dir, 'trunk.git');
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, landing: { ...config.landing, manualOverride: false }, trunk: { remote: trunk } }, null, 2) + '\n');
  box.git(box.repo, 'commit', '-q', '-am', 'chore: name the trunk remote of record [G1]');
  box.git(box.dir, 'clone', '-q', '--bare', box.repo, trunk);
  const [id] = box.ids;
  const { commit } = submitOne(box, id);
  const queue = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  assert.equal((await serveOnce(box, queue.url, 'r-gate')).code, 0);
  assert.equal(getItem(queue.board, id).item_status, 'submitted', 'the pulled gate put the item in review');
  verify(queue.board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'fixture acceptance of a gated item', head: commit, digest: getItem(queue.board, id).item_frozen_digest, policy: 'any' });
  return { box, trunk, id, commit, queue, tip: () => box.git(box.dir, '--git-dir', trunk, 'rev-parse', 'refs/heads/main') };
}

test('clause 1: under pull with trunk.remote set, the automatic lander offers one land job for the accepted item and merges nothing on the board host [P7]', { timeout: 240_000 }, // budget: hang ceiling for a project, a submit, a pulled gate and a lander child.
async t => {
  const { box, trunk, id, commit, queue, tip } = await acceptedOnPull(t);
  const main = box.git(box.repo, 'rev-parse', 'main'), before = tip();
  const result = landAfterAccept(box);
  const jobs = jobsOf(queue.board.db, { kind: 'land' });
  assert.equal(jobs.length, 1, `one land job; the lander answered ${JSON.stringify(result)}`);
  assert.equal(result.offered, jobs[0].id);
  const { payload } = jobs[0].steps.find(step => step.name === 'offered').payload;
  assert.deepEqual(payload.items, [{ id, commit, ref: `refs/pullboard/land/${id}` }]);
  assert.deepEqual([payload.remote, payload.trunk, payload.expect], [trunk, 'refs/heads/main', before]);
  assert.equal(box.git(box.dir, '--git-dir', trunk, 'rev-parse', `refs/pullboard/land/${id}`), commit, 'the item is published where the runner fetches');
  assert.deepEqual([box.git(box.repo, 'rev-parse', 'main'), tip()], [main, before], 'neither the board host\'s main nor trunk moved');
  assert.equal(landingBatches(queue.board).length, 0, 'no landing batch ran on the board host');
  assert.equal(getItem(queue.board, id).item_merged_commit, null);
  assert.equal(landAfterAccept(box).offered, jobs[0].id, 'a second wake offers no second job while one is open');
  assert.equal(jobsOf(queue.board.db, { kind: 'land' }).length, 1);
});

test('clause 2: runner serve takes the land job and posts its receipt, and the landing receipt marks the item merged at the pushed commit [P7]', { timeout: 240_000 }, // budget: as clause 1, plus a runner landing.
async t => {
  const { box, id, commit, queue, tip } = await acceptedOnPull(t);
  const before = tip();
  const offered = landAfterAccept(box);
  assert.equal(jobsOf(queue.board.db, { kind: 'land' }).length, 1, `the lander offered the land job: ${JSON.stringify(offered)}`);
  const served = await serveOnce(box, queue.url, 'r-land');
  assert.equal(served.code, 0, served.output);
  const [job] = jobsOf(queue.board.db, { kind: 'land' });
  assert.equal(job.step, 'done');
  const { receipt } = job.steps.find(step => step.name === 'receipt').payload;
  assert.deepEqual([receipt.outcome, receipt.landed, receipt.base], ['landed', [id], before], served.output);
  assert.equal(tip(), receipt.trunk, 'trunk is the pushed merge');
  assert.deepEqual(box.git(box.dir, '--git-dir', `${box.dir}/trunk.git`, 'rev-list', '--parents', '-n', '1', receipt.trunk).split(' ').slice(1), [before, commit]);
  const item = getItem(queue.board, id);
  assert.equal(item.item_merged_commit, receipt.trunk, 'merged at the pushed commit');
});
