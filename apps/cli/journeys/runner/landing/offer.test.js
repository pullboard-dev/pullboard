/** One landing path: accept offers the land job in any dispatch mode, and `land <id> --forced` offers the same kind [C7,P7]. */
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
import { context } from '../../../index.js';
import { landAfterAcceptance } from '../../../index.js';
import { wakeIo } from '../../../src/io/landing/automatic.js';
import { captureCommandInProcess } from '../../../tests/fixtures/process.js';
import { runCliInProcess } from '../../../tests/fixtures/process.js';
import { fixtureMachineSettings } from '../../../tests/fixtures/testkit.js';
import { pullProject } from '../../../tests/fixtures/pull.js';
import { pullQueue } from '../../../tests/fixtures/pull.js';
import { serveOnce } from '../../../tests/fixtures/pull.js';
import { submitOne } from '../../../tests/fixtures/pull.js';

/** Run the automatic lander's own entry in this process at the main checkout; return its answer and the ms it took. */
async function landAfterAccept(box) {
  let answer = null;
  const run = await captureCommandInProcess(async () => {
    const started = performance.now();
    const result = await landAfterAcceptance(context(wakeIo(box.repo)));
    answer = { result, ms: performance.now() - started };
    return 0;
  }, [], { cwd: box.repo, env: { ...box.env } });
  assert.equal(run.code, 0, run.err);
  return answer;
}

test('clause 1: accept offers a land job within 1 s under controller dispatch with no landing on the host, and land --forced offers the same kind with its reason [C7,P7]', { timeout: 240_000 }, // budget: hang ceiling for a project, a submit, a pulled gate, a lander child and a land command.
async t => {
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
  verify(queue.board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'fixture acceptance of a gated item', head: commit, digest: getItem(queue.board, id).item_frozen_digest, policy: 'any' });
  // Landing pulls whatever gate.runnerDispatch says: the gate ran by pull, the landing offer runs under controller.
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { localRunner: false, runnerDispatch: 'controller' } });
  const main = box.git(box.repo, 'rev-parse', 'main'), before = box.git(box.dir, '--git-dir', trunk, 'rev-parse', 'refs/heads/main');
  const { result, ms } = await landAfterAccept(box);
  const jobs = jobsOf(queue.board.db, { kind: 'land' });
  assert.equal(jobs.length, 1, `accept offered one land job; the lander answered ${JSON.stringify(result)}`);
  assert.equal(result.offered, jobs[0].id);
  assert.ok(ms < 1000, `the offer took ${Math.round(ms)} ms`);
  assert.deepEqual(jobs[0].steps.find(step => step.name === 'offered').payload.payload.items, [{ id, commit, ref: `refs/pullboard/land/${id}` }]);
  assert.equal(landingBatches(queue.board).length, 0, 'no landing batch ran on the board host');
  assert.deepEqual([box.git(box.repo, 'rev-parse', 'main'), box.git(box.dir, '--git-dir', trunk, 'rev-parse', 'refs/heads/main')], [main, before], 'nothing on the host merged or pushed');
  const forced = await runCliInProcess(['land', String(id), '--forced', 'the person escalated #1', '--json'], { cwd: box.repo, env: { ...box.env } });
  assert.equal(forced.code, 0, `${forced.err}\n${forced.out}`);
  const after = jobsOf(queue.board.db, { kind: 'land' });
  assert.equal(after.length, 2, 'the forced landing is a land job too');
  const offered = after.find(job => job.id !== jobs[0].id);
  const { payload } = offered.steps.find(step => step.name === 'offered').payload;
  assert.equal(offered.kind, 'land');
  assert.equal(payload.forced, 'the person escalated #1', 'the job carries its forced reason');
  assert.deepEqual(payload.items, [{ id, commit, ref: `refs/pullboard/land/${id}` }]);
  assert.equal(landingBatches(queue.board).length, 0, 'the forced landing ran nothing on the host either');
});
