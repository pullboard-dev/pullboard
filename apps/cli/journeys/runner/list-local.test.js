/** runner list names the auto-started local runner and its state, never 'no runners registered' beside a live one [C7,P7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';

const CLI = fileURLToPath(new URL('../../pullboard.js', import.meta.url));

/** A machine with no registered runner, and a local runner state file written as the runner writes it. */
function machine(_t, state) {
  const files = privateFixtureFiles('pb-list-local-');
  if (state) files.write('machine/local-runner/state.json', JSON.stringify(state));
  else files.write('machine/keep', '');
  const env = { PATH: process.env.PATH, HOME: files.root, PULLBOARD_HOME: files.root, PULLBOARD_MACHINE_HOME: join(files.root, 'machine') };
  return () => spawnSync(process.execPath, [CLI, 'runner', 'list'], { env, cwd: files.root, encoding: 'utf8' });
}

test('clause 1: a live local runner prints local (pid <n>, live), never no runners registered [P7]', t => {
  const list = machine(t, { pid: process.pid, runner: 'local', url: null, heartbeatAt: Date.now() });
  const out = list();
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes(`local (pid ${process.pid}, live)`), out.stdout);
  assert.ok(!out.stdout.includes('no runners registered'), out.stdout);
});

test('clause 2: a dead local runner prints local (stopped) [P7]', t => {
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const list = machine(t, { pid: Number(dead.stdout), runner: 'local', url: null, heartbeatAt: Date.now() });
  const out = list();
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes('local (stopped)'), out.stdout);
  assert.ok(!out.stdout.includes('no runners registered'), out.stdout);
});

test('clause 3: a machine that never started a local runner still says no runners registered [P7]', t => {
  const out = machine(t, null)();
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes('no runners registered'), out.stdout);
});
