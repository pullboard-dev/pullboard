/** Durable gate 11/20: a lost channel requeues its unfinished shards and keeps the runner; probes alone quarantine [C7]. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cleanupFixtureChildren, privateFixtureFiles, startFixtureChild } from './fixture-child.js';
import { createTransport, fetchResult, shellWord, startShard } from '../packages/transport/index.js';

after(cleanupFixtureChildren);

/** Ask the runner's own shell to wait, bounded, until a file exists. */
async function fileWritten(channel, file) {
  const reply = await channel.run(`i=0; while [ ! -f ${shellWord(file)} ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; [ -f ${shellWord(file)} ]`);
  assert.equal(reply.status, 0, `no file at ${file}`);
}

/** A fake adapter whose probe answers come from a list, on an injected clock. */
function scriptedProbes(clock, answers) {
  return {
    kind: 'fake',
    open: runner => ({ runner, alive: true, onLost: () => () => {}, close() {}, startShard: async () => ({}), fetchResult: async () => ({}) }),
    probe: async runner => ({ ok: answers.shift(), host: runner.host, at: clock.now }),
  };
}

test('clause 1: a lost channel requeues unfinished shards and keeps the runner; two failed probes 30 s apart quarantine [C7]', async () => {
  const files = privateFixtureFiles('pullboard-transport-11-');
  const requeued = [];
  const transport = createTransport({
    open: () => startFixtureChild('sh', [], { stdio: ['pipe', 'pipe', 'pipe'] }),
    launch: (runner, script) => startFixtureChild('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] }),
    requeue: lost => requeued.push(lost),
  });
  try {
    const runner = { host: 'runner-a', root: files.root };
    const channel = transport.connect(runner);
    const gate = `${files.root}/gate`;
    await startShard(channel, { job: 'job-1', shard: 's0', command: 'printf quick' });
    await startShard(channel, { job: 'job-1', shard: 's1', command: `printf x >> ../count; while [ ! -f ${shellWord(gate)} ]; do sleep 0.05; done; printf slow` });
    await fileWritten(channel, `${files.root}/transport/jobs/job-1/s0/result`);
    assert.equal((await fetchResult(channel, { job: 'job-1', shard: 's0' })).state, 'done');

    const lost = new Promise(resolve => channel.onLost(resolve));
    await assert.rejects(channel.run('kill -9 $$; sleep 5'), error => error.code === 'TRANSPORT_LOST');
    await lost;
    assert.equal(requeued.length, 1, 'the lost channel requeued once');
    assert.equal(requeued[0].runner.host, 'runner-a');
    assert.deepEqual(requeued[0].unfinished, [{ job: 'job-1', shard: 's1' }], 'only the shard never read back is requeued');
    assert.equal(transport.standing(runner).quarantined, false, 'a lost channel keeps the runner');

    const fresh = transport.connect(runner);
    assert.notEqual(fresh, channel, 'the kept runner takes a fresh channel');
    assert.equal((await startShard(fresh, { job: 'job-1', shard: 's1', command: 'printf never' })).state, 'running', 'the requeued shard is found still running, never started twice');
    await fresh.run(`: > ${shellWord(gate)}`);
    await fileWritten(fresh, `${files.root}/transport/jobs/job-1/s1/result`);
    const done = await fetchResult(fresh, { job: 'job-1', shard: 's1' });
    assert.equal(done.output.toString(), 'slow');
    assert.equal((await fresh.run(`cat ${shellWord(`${files.root}/transport/jobs/job-1/count`)}`)).output.toString(), 'x');
  } finally { transport.close(); }

  const clock = { now: 1_000_000 };
  const probes = createTransport({ adapter: scriptedProbes(clock, [false, false, false, true, false, false]), now: () => clock.now });
  const runner = { host: 'runner-b' };
  await probes.probe(runner);
  assert.equal(probes.standing(runner).quarantined, false, 'one failed probe never quarantines');
  clock.now += 10_000;
  await probes.probe(runner);
  assert.deepEqual([probes.standing(runner).quarantined, probes.standing(runner).failures], [false, 2], 'two failures 10 s apart do not quarantine');
  clock.now += 20_000;
  await probes.probe(runner);
  assert.equal(probes.standing(runner).quarantined, true, 'failures 30 s apart quarantine');
  clock.now += 1_000;
  await probes.probe(runner);
  assert.deepEqual([probes.standing(runner).quarantined, probes.standing(runner).live], [false, true], 'a good probe renews the lease and lifts quarantine');
  await probes.probe(runner);
  clock.now += 29_999;
  await probes.probe(runner);
  assert.equal(probes.standing(runner).quarantined, false, 'failures 29.999 s apart do not quarantine');
});

test('clause 1: runner health is a lease any adapter renews by heartbeat; a lapsed lease is not a quarantine [C7]', async () => {
  const clock = { now: 5_000_000 };
  const transport = createTransport({ adapter: scriptedProbes(clock, []), now: () => clock.now, leaseMs: 60_000 });
  const runner = { host: 'sandbox-1' };
  assert.equal(transport.standing(runner).live, false);
  transport.heartbeat(runner);
  assert.equal(transport.standing(runner).live, true);
  assert.equal(transport.standing(runner).until, 5_060_000);
  clock.now += 60_000;
  assert.deepEqual([transport.standing(runner).live, transport.standing(runner).quarantined], [false, false]);
});
