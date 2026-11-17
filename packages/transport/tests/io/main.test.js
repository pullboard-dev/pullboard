/** Durable gate 10/20: gates run on the runner's shared channel, with no runner-controller process on the Mac [C7]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { cleanupFixtureChildren } from '../../../../apps/cli/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureChildAsync } from '../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureExecFile } from '../../../../apps/cli/tests/fixtures/child.js';
import { startFixtureChild } from '../../../../apps/cli/tests/fixtures/child.js';
import { createTransport } from '../../index.js';
import { dispatchGate } from '../../index.js';
import { shellWord } from '../../index.js';
import { fetchResult } from '../../index.js';
import { startShard } from '../../index.js';
import { resultDigest } from '../../index.js';

after(cleanupFixtureChildren);

/** This process's direct children, as { pid, command } rows from the process table. */
function children() {
  const table = runFixtureExecFile('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).toString();
  return table.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)).filter(Boolean)
    .filter(match => Number(match[2]) === process.pid && !/^ps\s/u.test(match[3])).map(match => ({ pid: Number(match[1]), command: match[3] }));
}

test('transport.main.the-per-gate-runner-controller-is: clause 1: the per-gate runner-controller is replaced by the shared channel; the Mac process table holds none during six concurrent gates [C7]', async () => {
  const files = privateFixtureFiles('pullboard-transport-10-');
  files.write('roots/a/.keep', '');
  files.write('roots/b/.keep', '');
  const opened = [];
  const transport = createTransport({
    open: runner => { const child = startFixtureChild('sh', [], { stdio: ['pipe', 'pipe', 'pipe'] }); opened.push({ host: runner.host, pid: child.pid }); return child; },
    launch: (runner, script) => startFixtureChild('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] }),
  });
  try {
    const runners = [{ host: 'runner-a', root: `${files.root}/roots/a` }, { host: 'runner-b', root: `${files.root}/roots/b` }];
    const release = `${files.root}/release`;
    const gates = Array.from({ length: 6 }, (_, index) => dispatchGate({
      transport, runner: runners[index % 2], job: `gate-${index}`, owner: 'driver-a', intervalMs: 50,
      shards: ['s0', 's1'].map(shard => ({ shard, command: `while [ ! -f ${shellWord(release)} ]; do sleep 0.05; done; printf '${index}-${shard}'` })),
    }));

    for (const gate of gates) gate.catch(() => {}); // a failed assertion closes the channels; Promise.all below still sees it
    // Watch from a separate shell: a wait on the shared channel would queue ahead of the gates' own shard starts.
    for (const runner of runners) {
      const reply = await runFixtureChildAsync('sh', ['-c', `i=0; while [ "$(ls ${shellWord(runner.root)}/transport/jobs/*/*/started 2>/dev/null | wc -l | tr -d ' ')" -lt 6 ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; ls ${shellWord(runner.root)}/transport/jobs/*/*/started | wc -l`]);
      assert.equal(reply.stdout.trim(), '6', `three gates of two shards each are running on ${runner.host}`);
    }
    const table = children();
    assert.equal(table.filter(row => /runner-controller/u.test(row.command)).length, 0, 'no runner-controller process during six gates');
    assert.deepEqual(table.map(row => row.pid).sort(), opened.map(row => row.pid).sort(), 'the only processes are the one shared channel per runner');
    assert.equal(opened.length, 2, 'six gates on two runners opened two channels');

    files.write('release', '');
    const results = await Promise.all(gates);
    results.forEach((shards, index) => {
      assert.deepEqual(shards.map(row => [row.shard, row.status, row.output.toString()]), [['s0', 0, `${index}-s0`], ['s1', 0, `${index}-s1`]]);
      for (const row of shards) assert.match(row.digest, /^[0-9a-f]{64}$/u);
    });
  } finally { transport.close(); }
});

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

test('transport.main.a-lost-channel-requeues-unfinished-shards: clause 1: a lost channel requeues unfinished shards and keeps the runner; two failed probes 30 s apart quarantine [C7]', async () => {
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

test('transport.main.runner-health-is-a-lease-any: clause 1: runner health is a lease any adapter renews by heartbeat; a lapsed lease is not a quarantine [C7]', async () => {
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

after(cleanupFixtureChildren);

/** A transport whose runner shell is a real local `sh`, counting every process it starts. */
function localTransport({ probeExit = 0 } = {}) {
  const opened = [], launched = [];
  const transport = createTransport({
    open: runner => { const child = startFixtureChild('sh', [], { stdio: ['pipe', 'pipe', 'pipe'] }); opened.push({ host: runner.host, pid: child.pid }); return child; },
    launch: (runner, script) => { launched.push({ host: runner.host, script }); return startFixtureChild('sh', ['-c', probeExit ? `exit ${probeExit}` : script], { stdio: ['ignore', 'pipe', 'pipe'] }); },
  });
  return { transport, opened, launched };
}

test('transport.main.connect-runner-returns-a-reused-channel: clause 1: connect(runner) returns a reused channel; two gates on one runner share it; probe is a separate call [C7]', async () => {
  const { transport, opened, launched } = localTransport();
  try {
    const runner = { host: 'runner-a' };
    const gateA = transport.connect(runner);
    const gateB = transport.connect({ host: 'runner-a' });
    assert.equal(gateA, gateB, 'a second connect to the same runner reuses the live channel');
    assert.equal(opened.length, 1, 'one process is opened for the runner');

    const [first, second] = await Promise.all([gateA.run('printf gate-a; printf " $$"'), gateB.run('printf gate-b; printf " $$"')]);
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    const [labelA, pidA] = first.output.toString().split(' ');
    const [labelB, pidB] = second.output.toString().split(' ');
    assert.deepEqual([labelA, labelB], ['gate-a', 'gate-b'], 'each gate gets its own reply');
    assert.equal(pidA, pidB, 'both gates ran on the one shared runner shell');
    assert.equal(Number(pidA), opened[0].pid);
    assert.equal(gateA.requests, 2);

    const other = transport.connect({ host: 'runner-b' });
    assert.notEqual(other, gateA, 'another runner gets its own channel');
    assert.equal(opened.length, 2);

    const answer = await transport.probe(runner);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.host, 'runner-a');
    assert.equal(launched.length, 1, 'the probe is its own call');
    assert.equal(opened.length, 2, 'the probe never opens or reuses a channel');
    assert.equal(gateA.requests, 2, 'the probe sent nothing over the channel');
  } finally { transport.close(); }
});

test('transport.main.a-failed-probe-leaves-the-shared: clause 1: a failed probe leaves the shared channel serving its gates [C7]', async () => {
  const { transport } = localTransport({ probeExit: 255 });
  try {
    const runner = { host: 'runner-a' };
    const channel = transport.connect(runner);
    const answer = await transport.probe(runner);
    assert.equal(answer.ok, false);
    assert.match(answer.reason, /exit 255/u);
    assert.equal(channel.alive, true);
    const reply = await channel.run('printf still-here');
    assert.equal(reply.output.toString(), 'still-here');
  } finally { transport.close(); }
});

test('transport.main.the-channel-keeps-arbitrary-output-statuses: clause 1: the channel keeps arbitrary output, statuses and syntax errors to their own request [C7]', async () => {
  const { transport } = localTransport();
  try {
    const channel = transport.connect({ host: 'runner-a' });
    const quoted = await channel.run(`printf '%s' "it's __PB_END x 0"`);
    assert.equal(quoted.output.toString(), "it's __PB_END x 0");
    const failed = await channel.run('printf no; exit 7');
    assert.deepEqual([failed.status, failed.output.toString()], [7, 'no']);
    const broken = await channel.run('if then');
    assert.notEqual(broken.status, 0);
    const lines = await channel.run('printf "a\\n\\nb\\n"');
    assert.equal(lines.output.toString(), 'a\n\nb\n');
    assert.equal(channel.alive, true, 'no request can end the shared shell');
  } finally { transport.close(); }
});

test('transport.main.a-lost-channel-is-replaced-on: clause 1: a lost channel is replaced on the next connect, and its pending request is refused [C7]', async () => {
  const { transport, opened } = localTransport();
  try {
    const runner = { host: 'runner-a' };
    const channel = transport.connect(runner);
    const lost = new Promise(resolve => channel.onLost(resolve));
    const hung = channel.run('kill -9 $$; sleep 5');
    await assert.rejects(hung, error => error.code === 'TRANSPORT_LOST');
    assert.equal((await lost).code, 'TRANSPORT_LOST');
    assert.equal(channel.alive, false);
    const fresh = transport.connect(runner);
    assert.notEqual(fresh, channel);
    assert.equal(opened.length, 2);
    assert.equal((await fresh.run('printf back')).output.toString(), 'back');
  } finally { transport.close(); }
});

after(cleanupFixtureChildren);

/** A transport whose runner shell is a real local `sh`. */
function localTransportPart4() {
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

test('transport.main.startshard-writes-job-shard-files-on: clause 1: startShard writes job/shard files on the runner; fetchResult reads by digest; an invalid file is import.invalid and the shard resets [C7]', async () => {
  const files = privateFixtureFiles('pullboard-transport-9-');
  const transport = localTransportPart4();
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

test('transport.main.a-cut-short-result-file-is: clause 1: a cut-short result file is import.invalid and resets its shard [C7]', async () => {
  const files = privateFixtureFiles('pullboard-transport-9-');
  const transport = localTransportPart4();
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

test('transport.main.a-started-shard-is-not-started: clause 1: a started shard is not started twice and its result outlives the channel that started it [C7]', async () => {
  const files = privateFixtureFiles('pullboard-transport-9-');
  const transport = localTransportPart4();
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

test('transport.main.shard-ids-are-plain-names-never: clause 1: shard ids are plain names, never paths [C7]', async () => {
  const transport = localTransportPart4();
  try {
    const channel = transport.connect({ host: 'runner-a' });
    await assert.rejects(startShard(channel, { job: '../x', shard: 's', command: 'true' }), error => error.code === 'TRANSPORT_SHARD_ID');
    await assert.rejects(fetchResult(channel, { job: 'j', shard: 'a/b' }), error => error.code === 'TRANSPORT_SHARD_ID');
  } finally { transport.close(); }
});

test('transport.main.startshard-and-fetchresult-go-through-the: clause 1: startShard and fetchResult go through the runner adapter, so a non-SSH adapter plugs in the same way [C7]', async () => {
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
