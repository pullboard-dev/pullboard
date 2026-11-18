/** A test file that hangs resolves as HUNG soon after its cap, even when a grandchild holds its output open [C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../../../apps/cli/src/io/run/tests.js', import.meta.url));
const CAP_MS = 2000;
const SLACK_MS = 10_000;

/** Run one fixture file under a short whole-file wall; resolve when run-tests exits, with its wall time and output. */
async function runFile(t, name, source) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-hang-cap-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, name), source);
  const env = { ...process.env, PULLBOARD_MACHINE_HOME: join(root, 'machine'), PULLBOARD_TEST_TIMEOUT_MS: '60000',
    PULLBOARD_TEST_FILE_LIMITS: JSON.stringify({ [name]: CAP_MS }), PULLBOARD_TEST_IDLE_TIMEOUT_MS: '1000' };
  for (const key of ['NODE_TEST_CONTEXT', 'PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN']) delete env[key];
  const child = spawn(process.execPath, [runner, join(root, name)], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } rmSync(root, { recursive: true, force: true }); });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const started = Date.now();
  const status = await new Promise(resolve => {
    const guard = setTimeout(() => resolve('unresolved'), CAP_MS + SLACK_MS + 20_000);
    child.once('exit', code => { clearTimeout(guard); resolve(code); });
  });
  return { status, output, ms: Date.now() - started };
}

test('runners.cap.a-test-file-that-never-exits: a test file that never exits resolves as HUNG within 10 s after its cap, with partial output [C7]', async t => {
  const { status, output, ms } = await runFile(t, 'plain.test.js', `import { test } from 'node:test';
test('partial output kept [C7]', () => { console.log('PARTIAL-MARK'); });
test('the hang [C7]', () => new Promise(() => setInterval(() => {}, 1000)));
`);
  assert.equal(status, 1, output);
  assert.match(output, /HUNG file|TIMEOUT file/u);
  assert.match(output, /PARTIAL-MARK/u);
  assert.ok(ms < CAP_MS + SLACK_MS, `resolved after ${ms}ms: ${output}`);
});

test('runners.cap.a-child-forking-a-grandchild-that: a child forking a grandchild that holds stdout open still resolves within 10 s after the cap [C7]', async t => {
  const { status, output, ms } = await runFile(t, 'grandchild.test.js', `import { test } from 'node:test';
import { spawn } from 'node:child_process';
test('forks a grandchild holding the output [C7]', () => {
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }).unref();
  console.log('PARTIAL-MARK');
  return new Promise(() => setInterval(() => {}, 1000));
});
`);
  assert.equal(status, 1, output);
  assert.match(output, /HUNG file|TIMEOUT file/u);
  assert.match(output, /PARTIAL-MARK/u);
  assert.ok(ms < CAP_MS + SLACK_MS, `resolved after ${ms}ms: ${output}`);
});
