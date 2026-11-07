/** Durable gate 8/20: one reused channel per runner, shared by its gates, with the probe apart from it [C7]. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cleanupFixtureChildren, startFixtureChild } from './fixture-child.js';
import { createTransport } from '../packages/transport/index.js';

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

test('clause 1: connect(runner) returns a reused channel; two gates on one runner share it; probe is a separate call [C7]', async () => {
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

test('clause 1: a failed probe leaves the shared channel serving its gates [C7]', async () => {
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

test('clause 1: the channel keeps arbitrary output, statuses and syntax errors to their own request [C7]', async () => {
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

test('clause 1: a lost channel is replaced on the next connect, and its pending request is refused [C7]', async () => {
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
