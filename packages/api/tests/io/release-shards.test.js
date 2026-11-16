/** A release offers its shards as gate-shard board jobs and records each claimed one as participation [P7,C7,#8165]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { SHARD_JOB_KIND } from '../../index.js';
import { boardJobQueueCall } from '../../index.js';
import { claimJob } from '../../index.js';
import { jobRequest } from '../../index.js';
import { offerReleaseShards } from '../../index.js';
import { releaseParticipationShards } from '../../index.js';

const HEAD = 'b'.repeat(40), BASE = 'a'.repeat(40), RELEASE = '11111111-2222-3333-4444-555555555555';
const GATE = { run: ['node', '-e', 'x'], entry: 'gate.js', commits: [BASE] };
const SHARDS = [{ files: ['packages/x/tests/a.test.js', 'packages/x/tests/c.test.js'], command: "node --test './packages/x/tests/a.test.js'" }, { files: ['packages/x/tests/b.test.js'], command: "node --test './packages/x/tests/b.test.js'" }];

test('#8165 clause 1: with pull dispatch on, a release offers each shard as a gate-shard job release:<id>:shard:N through offerJob [C7,P7]', t => {
  const { db } = cellBoard(t, ':memory:');
  const ids = offerReleaseShards(db, { release: RELEASE, head: HEAD, base: BASE, mode: 'pull', gate: GATE, shards: SHARDS, now: 1 });
  assert.deepEqual(ids, [`release:${RELEASE}:shard:1`, `release:${RELEASE}:shard:2`]);
  const held = claimJob(db, { runner: 'r1', capabilities: [], now: 2 });
  const row = jobRequest(db, { job: held.job, runner: 'r1', token: held.token });
  assert.equal(row.kind, SHARD_JOB_KIND);
  assert.equal(row.candidate, HEAD);
  assert.equal(row.base, BASE);
  assert.deepEqual(row.request.input.data.shard, { index: 1, of: 2, files: SHARDS[0].files, command: SHARDS[0].command });
  assert.equal(row.request.gate, `release:${RELEASE}`);
  assert.deepEqual(offerReleaseShards(db, { release: RELEASE, head: HEAD, base: BASE, mode: 'pull', gate: GATE, shards: SHARDS, now: 9 }), ids, 'a retried offer leaves the held shard as it is');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job').get().n, 2);
});

test('#8165 clause 1: a release offers nothing while dispatch is not pull, and refuses a plan that is not one [C7,P7]', t => {
  const { db } = cellBoard(t, ':memory:');
  assert.throws(() => offerReleaseShards(db, { release: RELEASE, head: HEAD, base: BASE, mode: 'controller', gate: GATE, shards: SHARDS }), error => error.code === 'RELEASE_SHARDS_MODE');
  assert.throws(() => offerReleaseShards(db, { release: RELEASE, head: 'abc', base: BASE, mode: 'pull', gate: GATE, shards: SHARDS }), error => error.code === 'RELEASE_SHARDS');
  assert.throws(() => offerReleaseShards(db, { release: RELEASE, head: HEAD, base: BASE, mode: 'pull', gate: GATE, shards: [] }), error => error.code === 'RELEASE_SHARDS');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job').get().n, 0);
});

test('#8165 clause 1: participation.shards records each claimed shard with its runner, head, tree and command, and a posted green receipt [C7,P7]', t => {
  const { db, ...board } = cellBoard(t, ':memory:');
  offerReleaseShards(db, { release: RELEASE, head: HEAD, base: BASE, mode: 'pull', gate: GATE, shards: SHARDS, now: 1 });
  const fields = { release: RELEASE, head: HEAD, tree: 'c'.repeat(40), shards: SHARDS };
  assert.ok(releaseParticipationShards(db, fields).every(row => row.executor === null && row.green === false && row.command === null), 'nothing is claimed yet');
  const held = claimJob(db, { runner: 'runner-a', capabilities: [], now: 2 });
  const mid = releaseParticipationShards(db, fields);
  assert.equal(mid[0].executor, 'runner-a');
  assert.equal(mid[0].head, HEAD);
  assert.equal(mid[0].tree, fields.tree);
  assert.match(mid[0].command, /^[0-9a-f]{64}$/u);
  assert.equal(mid[1].executor, null);
  assert.equal(mid[0].green, false);
  boardJobQueueCall({ db, ...board }, { action: 'receipt', job: held.job, runner: 'runner-a', token: held.token, receipt: { version: 1, status: 0, gate: { green: true, cleanupVerified: true, phases: [] } } }, { mode: 'pull', now: 3 });
  const after = releaseParticipationShards(db, fields);
  assert.deepEqual(after[0], { shard: '1/2', files: [...SHARDS[0].files].sort(), executor: 'runner-a', head: HEAD, tree: fields.tree, command: mid[0].command, green: true, complete: true, cleanupVerified: true });
});
