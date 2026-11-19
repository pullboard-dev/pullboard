/** One contract suite holds the real ssh adapter, with a stubbed spawn, and the fake adapter to the same answer and refusal [C7,#1427]. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createFakeSshAdapter } from '../../../src/io/adapter/ssh.js';
import { createSshAdapter } from '../../../src/io/adapter/ssh.js';

/** A spawn stand-in: a child that answers "hello" on stdout, "warn" on stderr and exits 3, recording the ssh arguments. */
function stubSpawn(calls) {
  return (command, args) => {
    calls.push({ command, args });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} });
    setImmediate(() => {
      child.stdout.write('hello');
      child.stderr.write('warn');
      setImmediate(() => child.emit('close', 3, null));
    });
    return child;
  };
}

/** Both forms, built to give the same answer for a script run on the runner. */
function forms(dir, calls) {
  return {
    real: createSshAdapter({ spawnFn: stubSpawn(calls), dir }),
    fake: createFakeSshAdapter(() => ({ status: 3, stdout: 'hello', stderr: 'warn' })),
  };
}

test('runners.io-adapter-ssh.both-forms-answer-a-script: clause 1: one contract suite runs createSshAdapter (with a stubbed spawn) and createFakeSshAdapter and both return { status, stdout, stderr } for a script run on a runner [C7,#1427]', async () => {
  const dir = tmpdir();
  {
    const calls = [];
    for (const [form, adapter] of Object.entries(forms(dir, calls))) {
      const result = await adapter.run({ host: 'runner-1' }, 'echo hello');
      assert.deepEqual(Object.keys(result).sort(), ['status', 'stderr', 'stdout'], form);
      assert.equal(result.status, 3, form);
      assert.equal(result.stdout.toString('utf8'), 'hello', form);
      assert.equal(result.stderr, 'warn', form);
    }
    assert.equal(calls.length, 1, 'only the real form spawned');
    assert.equal(calls[0].args.includes('runner-1'), true, 'it reached the runner host');
  }
});

test('runners.io-adapter-ssh.both-forms-refuse-no-host: clause 2: both forms refuse a missing runner host with the same named refusal [C7,#1427]', async () => {
  const dir = tmpdir();
  {
    const calls = [];
    for (const [form, adapter] of Object.entries(forms(dir, calls))) {
      for (const runner of [{}, { host: '' }, { host: '  ' }, null]) {
        await assert.rejects(() => adapter.run(runner, 'true'), { code: 'SSH_RUNNER_HOST' }, form);
      }
    }
    assert.equal(calls.length, 0, 'a refused run spawns nothing');
  }
});
