/** Durable gate 9/20: shards run detached on the runner and leave result files the driver reads by digest [C7]. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cleanupFixtureChildren, privateFixtureFiles, startFixtureChild } from './fixture-child.js';
import { createTransport, fetchResult, resultDigest, startShard } from '../packages/transport/index.js';
import { shellWord } from '../packages/transport/index.js';

after(cleanupFixtureChildren);

/** A transport whose runner shell is a real local `sh`. */
function localTransport() {
  return createTransport({
    open: () => startFixtureChild('sh', [], { stdio: ['pipe', 'pipe', 'pipe'] }),
    launch: (runner, script) => startFixtureChild('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] }),
  });
}

/** Ask the runner's own shell to wait, bounded, until the shard's result file exists. */
async function resultWritten(channel, root, job, shard) {
  const file = `${root}/transport/jobs/${job}/${shard}/result`;
  const reply = await channel.run(`i=0; while [ ! -f ${shellWord(file)} ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; [ -f ${shellWord(file)} ]`);
  assert.equal(reply.status, 0, `no result file at ${file}`);
}

test('clause 1: startShard writes job/shard files on the runner; fetchResult reads by digest; an invalid file is import.invalid and the shard resets [C7]', async () => {
  const files = privateFixtureFiles('pullboard-transport-9-');
  const transport = localTransport();
  try {
    const channel = transport.connect({ host: 'runner-a', root: files.root });
    const shard = { job: 'job-1', shard: 's0', owner: 'driver-a' };
    const started = await startShard(channel, { ...shard, command: 'printf "two lines\\nok"; exit 3' });
    assert.equal(started.state, 'started');
    await resultWritten(channel, files.root, 'job-1', 's0');

    const record = JSON.parse((await channel.run(`cat ${shellWord(`${files.root}/transport/jobs/job-1/s0/job.json`)}`)).output.toString());
    assert.deepEqual(record, { version: 1, job: 'job-1', shard: 's0', owner: 'driver-a' }, 'the job file names the job, shard and lease owner');

    const done = await fetchResult(channel, shard);
    assert.equal(done.state, 'done');
    assert.equal(done.status, 3);
    assert.equal(done.output.toString(), 'two lines\nok');
    const onDisk = (await channel.run(`cat ${shellWord(`${files.root}/transport/jobs/job-1/s0/result`)}`)).output;
    assert.equal(done.digest, resultDigest(onDisk), 'the digest names the result file bytes');

    const again = await fetchResult(channel, { ...shard, digest: done.digest });
    assert.equal(again.state, 'done', 'a read by the recorded digest returns the same result');
    assert.equal(again.digest, done.digest);
    assert.equal((await startShard(channel, { ...shard, command: 'exit 0' })).state, 'done', 'a finished shard is never rerun');

    const wrong = await fetchResult(channel, { ...shard, digest: '0'.repeat(63) + '1' });
    assert.equal(wrong.state, 'import.invalid', 'a result that is not the recorded digest is invalid');
    assert.equal(wrong.reset, true);
    assert.deepEqual(await fetchResult(channel, shard), { state: 'absent' }, 'the shard reset to not started');

    assert.equal((await startShard(channel, { ...shard, command: 'printf again' })).state, 'started', 'a reset shard starts again');
    await resultWritten(channel, files.root, 'job-1', 's0');
    assert.equal((await fetchResult(channel, shard)).output.toString(), 'again');
  } finally { transport.close(); }
});

test('clause 1: a cut-short result file is import.invalid and resets its shard [C7]', async () => {
  const files = privateFixtureFiles('pullboard-transport-9-');
  const transport = localTransport();
  try {
    const channel = transport.connect({ host: 'runner-a', root: files.root });
    const shard = { job: 'job-2', shard: 's1' };
    await startShard(channel, { ...shard, command: 'printf 0123456789' });
    await resultWritten(channel, files.root, 'job-2', 's1');
    const folder = `${files.root}/transport/jobs/job-2/s1`;
    await channel.run(`head -c 20 ${shellWord(`${folder}/result`)} > ${shellWord(`${folder}/cut`)} && mv ${shellWord(`${folder}/cut`)} ${shellWord(`${folder}/result`)}`);
    const invalid = await fetchResult(channel, shard);
    assert.equal(invalid.state, 'import.invalid');
    assert.match(invalid.reason, /output bytes/u);
    assert.deepEqual(await fetchResult(channel, shard), { state: 'absent' });

    await channel.run(`mkdir -p ${shellWord(folder)} && : > ${shellWord(`${folder}/started`)} && printf 'garbage' > ${shellWord(`${folder}/result`)}`);
    const garbage = await fetchResult(channel, shard);
    assert.equal(garbage.state, 'import.invalid');
    assert.match(garbage.reason, /header/u);
    assert.deepEqual(await fetchResult(channel, shard), { state: 'absent' });
  } finally { transport.close(); }
});

test('clause 1: a started shard is not started twice and its result outlives the channel that started it [C7]', async () => {
  const files = privateFixtureFiles('pullboard-transport-9-');
  const transport = localTransport();
  try {
    const runner = { host: 'runner-a', root: files.root };
    const channel = transport.connect(runner);
    const shard = { job: 'job-3', shard: 's2' };
    const gate = `${files.root}/gate`;
    const command = `printf x >> ../count; while [ ! -f ${shellWord(gate)} ]; do sleep 0.05; done; printf finished`;
    assert.equal((await startShard(channel, { ...shard, command })).state, 'started');
    assert.equal((await startShard(channel, { ...shard, command })).state, 'running', 'a running shard is left alone');
    assert.deepEqual(await fetchResult(channel, shard), { state: 'running' });
    channel.close();

    const fresh = transport.connect(runner);
    assert.notEqual(fresh, channel);
    await fresh.run(`: > ${shellWord(gate)}`);
    await resultWritten(fresh, files.root, 'job-3', 's2');
    const done = await fetchResult(fresh, shard);
    assert.equal(done.state, 'done', 'the result is a fact on the runner, read by the next channel');
    assert.equal(done.output.toString(), 'finished');
    assert.equal((await fresh.run(`cat ${shellWord(`${files.root}/transport/jobs/job-3/count`)}`)).output.toString(), 'x', 'the command ran once');
  } finally { transport.close(); }
});

test('clause 1: shard ids are plain names, never paths [C7]', async () => {
  const transport = localTransport();
  try {
    const channel = transport.connect({ host: 'runner-a' });
    await assert.rejects(startShard(channel, { job: '../x', shard: 's', command: 'true' }), error => error.code === 'TRANSPORT_SHARD_ID');
    await assert.rejects(fetchResult(channel, { job: 'j', shard: 'a/b' }), error => error.code === 'TRANSPORT_SHARD_ID');
  } finally { transport.close(); }
});

test('clause 1: startShard and fetchResult go through the runner adapter, so a non-SSH adapter plugs in the same way [C7]', async () => {
  const calls = [];
  const adapter = {
    kind: 'fake',
    open: runner => ({
      runner, alive: true, onLost: () => () => {}, close() {},
      startShard: spec => { calls.push(['start', runner.host, spec.job, spec.shard]); return Promise.resolve({ state: 'started', job: spec.job, shard: spec.shard }); },
      fetchResult: spec => { calls.push(['fetch', runner.host, spec.job, spec.shard]); return Promise.resolve({ state: 'running' }); },
    }),
    probe: runner => Promise.resolve({ ok: true, host: runner.host }),
  };
  const transport = createTransport({ adapter });
  const channel = transport.connect({ host: 'sandbox-1' });
  assert.equal((await startShard(channel, { job: 'j', shard: 's', command: 'true' })).state, 'started');
  assert.deepEqual(await fetchResult(channel, { job: 'j', shard: 's' }), { state: 'running' });
  assert.deepEqual(calls, [['start', 'sandbox-1', 'j', 's'], ['fetch', 'sandbox-1', 'j', 's']]);
});
