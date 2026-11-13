/** runner list names the auto-started local runner and its state, never 'no runners registered' beside a live one [C7,P7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

/** A process id no process holds: the first one below the usual ceiling that the kernel says does not exist. */
function deadPid() {
  for (let pid = 99_000; pid > 1000; pid--) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return pid; }
  }
  throw new Error('no free process id');
}

/** A machine with no registered runner, and a local runner state file written as the runner writes it. */
function machine(_t, state) {
  const files = privateFixtureFiles('pb-list-local-');
  if (state) files.write('machine/local-runner/state.json', JSON.stringify(state));
  else files.write('machine/keep', '');
  const env = { PATH: process.env.PATH, HOME: files.root, PULLBOARD_HOME: files.root, PULLBOARD_MACHINE_HOME: join(files.root, 'machine') };
  return () => runCliInProcess(['runner', 'list'], { env, cwd: files.root });
}

test('clause 1: a live local runner prints local (pid <n>, live), never no runners registered [P7]', async t => {
  const list = machine(t, { pid: process.pid, runner: 'local', url: null, heartbeatAt: Date.now() });
  const out = await list();
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes(`local (pid ${process.pid}, live)`), out.stdout);
  assert.ok(!out.stdout.includes('no runners registered'), out.stdout);
});

test('clause 2: a dead local runner prints local (stopped) [P7]', async t => {
  const list = machine(t, { pid: deadPid(), runner: 'local', url: null, heartbeatAt: Date.now() });
  const out = await list();
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes('local (stopped)'), out.stdout);
  assert.ok(!out.stdout.includes('no runners registered'), out.stdout);
});

test('clause 3: a machine that never started a local runner still says no runners registered [P7]', async t => {
  const out = await machine(t, null)();
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes('no runners registered'), out.stdout);
});
