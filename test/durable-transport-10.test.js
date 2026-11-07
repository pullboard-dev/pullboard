/** Durable gate 10/20: gates run on the runner's shared channel, with no runner-controller process on the Mac [C7]. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cleanupFixtureChildren, privateFixtureFiles, runFixtureExecFile, startFixtureChild } from './fixture-child.js';
import { createTransport, runGate, shellWord } from '../packages/transport/index.js';

after(cleanupFixtureChildren);

/** This process's direct children, as { pid, command } rows from the process table. */
function children() {
  const table = runFixtureExecFile('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).toString();
  return table.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)).filter(Boolean)
    .filter(match => Number(match[2]) === process.pid && !/^ps\s/u.test(match[3])).map(match => ({ pid: Number(match[1]), command: match[3] }));
}

test('clause 1: the per-gate runner-controller is replaced by the shared channel; the Mac process table holds none during six concurrent gates [C7]', async () => {
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
    const gates = Array.from({ length: 6 }, (_, index) => runGate({
      transport, runner: runners[index % 2], job: `gate-${index}`, owner: 'driver-a', intervalMs: 50,
      shards: ['s0', 's1'].map(shard => ({ shard, command: `while [ ! -f ${shellWord(release)} ]; do sleep 0.05; done; printf '${index}-${shard}'` })),
    }));

    for (const runner of runners) {
      const reply = await transport.connect(runner).run(`i=0; while [ "$(ls ${shellWord(runner.root)}/transport/jobs/*/*/started 2>/dev/null | wc -l | tr -d ' ')" -lt 6 ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; ls ${shellWord(runner.root)}/transport/jobs/*/*/started | wc -l`);
      assert.equal(reply.output.toString().trim(), '6', `three gates of two shards each are running on ${runner.host}`);
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
