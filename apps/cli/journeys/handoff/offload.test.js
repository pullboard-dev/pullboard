/** A gate runs entirely as one runner job, and with no runners the local runner takes a job only under its load share [P7,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobQueueCall } from '../../../../packages/api/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { localLoadAdmits } from '../../../../packages/drive/index.js';
import { serveRunner } from '../../../../packages/drive/index.js';
import { hostProcesses } from '../../tests/fixtures/pull.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';

test('clause 1: a submit copies no tooling and composes nothing; the runner job fetches the commit and does that work [P7,C7]', async t => {
  const box = await pullProject(t, 1);
  const [id] = box.ids;
  const before = hostProcesses(box.dir);
  const { folder, commit } = submitOne(box, id);
  assert.equal(hostProcesses(box.dir), before, 'the submit left no process on the submitting machine');
  for (const place of [folder, box.web, box.repo]) assert.equal(existsSync(join(place, '.git', 'gate-steps.jsonl')), false, `no gate step ran in ${place}`);
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => jobQueueCall(current.db, body, { mode: 'pull', trunk: () => box.repo }) });
  const [offered] = jobsOf(board.db, { kind: 'gate', item: id });
  assert.deepEqual([offered.step, offered.candidate], ['offered', commit], 'one gate job row names the commit, and no history was composed for it');
  const served = await serveOnce(box, url, 'runner-a');
  assert.equal(served.code, 0, served.output);
  const steps = readFileSync(join(box.runnerHome, 'runner-a-steps.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const names = new Set(steps.map(step => step.step));
  for (const part of ['authorization', 'placement', 'cells', 'selection', 'proof']) assert.ok(names.has(part), `${part} ran in the runner job`);
  assert.ok(steps.every(step => step.pid !== process.pid), 'none of it ran on the submitting machine');
  assert.equal(jobsOf(board.db, { kind: 'gate', item: id })[0].step, 'done');
});

test('clause 2: the default load share is 1.0 per core, and a load at or over it admits no job [P7,C7]', () => {
  assert.equal(localLoadAdmits({ load: 3.9, cores: 4, share: 1 }), true);
  assert.equal(localLoadAdmits({ load: 4, cores: 4, share: 1 }), false);
  assert.equal(localLoadAdmits({ load: 1.9, cores: 4, share: 0.5 }), true);
  assert.equal(localLoadAdmits({ load: 2, cores: 4, share: 0.5 }), false);
});

test('clause 2: with no runners a loaded machine leaves the row waiting, and it still runs once the load falls [P7,C7]', async t => {
  const box = await pullProject(t, 1);
  const [id] = box.ids;
  submitOne(box, id);
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => jobQueueCall(current.db, body, { mode: 'pull', trunk: () => box.repo }) });
  const lines = [];
  const loaded = await serveRunner({ board: url, runner: 'local-busy', once: true, admit: () => localLoadAdmits({ load: 8, cores: 4, share: 1 }),
    cache: join(box.runnerHome, 'busy'), say: line => lines.push(line) });
  assert.deepEqual(loaded.jobs, [], 'no job was taken');
  assert.match(lines.join('\n'), /over its load share/u);
  assert.equal(jobsOf(board.db, { kind: 'gate', item: id })[0].step, 'offered', 'the row waits in the queue');
  const served = await serveOnce(box, url, 'runner-quiet');
  assert.equal(served.code, 0, served.output);
  assert.equal(jobsOf(board.db, { kind: 'gate', item: id })[0].step, 'done');
});
