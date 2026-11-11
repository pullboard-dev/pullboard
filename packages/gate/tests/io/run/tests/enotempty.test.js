/** @pullboard-test-input source-tree */
/** @pullboard-test-loads apps/cli/src/io/run/tests.js */
/** The real runner waits for an owned late writer before its one sandbox removal [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { awaitNestedRun } from '../../../../index.js';
import { removeTestSandbox } from '../../../../index.js';
import { TEST_CHILD_CLEANUP_FAILED } from '../../../../index.js';
import { runFixtureChildAsync } from '../../../../../../apps/cli/tests/fixtures/child.js';
import { waitForCondition } from '../../../../../../apps/cli/tests/fixtures/runner/holders.js';

const RUNNER = resolve(import.meta.dirname, '../../../../../../apps/cli/src/io/run/tests.js');

test('a real run drains its late-writing child and removes the sandbox once [C7]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-cleanup-run-'));
  const marker = join(directory, 'waiting.json');
  const release = join(directory, 'release');
  const done = join(directory, 'writer-done');
  const exiting = join(directory, 'worker-exit.json');
  const sandboxFile = join(directory, 'sandbox-path');
  let outcome;
  t.after(async () => {
    writeFileSync(release, 'finish');
    if (outcome) await outcome;
    if (existsSync(done + '.ready')) await waitForCondition(() => existsSync(done), 'the fixture writer to finish before fixture removal');
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(join(directory, 'test'));
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(directory, 'writer.cjs'), `const fs = require('node:fs');
const path = require('node:path');
const [sandbox, release, done] = process.argv.slice(2);
let finished = false;
/** Finish a fixed number of actual writes only when the owning fixture releases cleanup. */
function finish() {
  if (finished || !fs.existsSync(release)) return;
  finished = true;
  const late = path.join(sandbox, 'late');
  fs.mkdirSync(late, { recursive: true });
  for (let i = 0; i < 32; i++) fs.writeFileSync(path.join(late, String(i)), 'late write');
  fs.writeFileSync(done, '32');
  watcher.close();
  process.exit(0);
}
const watcher = fs.watch(path.dirname(release), finish);
fs.writeFileSync(done + '.ready', 'ready');
process.send('ready');
finish();
`);
  writeFileSync(join(directory, 'test/late.test.js'), `import { test } from 'node:test';
import { once } from 'node:events';
import { channel } from 'node:diagnostics_channel';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
const sandbox = process.env.TMPDIR;
writeFileSync(${JSON.stringify(sandboxFile)}, sandbox);
channel('pullboard:test-child-drain').subscribe(event => writeFileSync(${JSON.stringify(marker)}, JSON.stringify(event)));
process.once('exit', () => writeFileSync(${JSON.stringify(exiting)}, JSON.stringify({ writerFinished: existsSync(${JSON.stringify(done)}) })));
test('the owned child writes during runner cleanup [C7]', async () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // This finite writer is not another native test worker.
  const child = spawn(process.execPath, [${JSON.stringify(join(directory, 'writer.cjs'))}, sandbox, ${JSON.stringify(release)}, ${JSON.stringify(done)}],
    { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await once(child, 'message');
  writeFileSync(${JSON.stringify(marker + '.writer')}, String(child.pid));
  child.disconnect();
  child.unref();
});
`);
  let finished = false;
  let failure;
  outcome = awaitNestedRun(runFixtureChildAsync(process.execPath, [RUNNER, 'test/late.test.js'], {
    cwd: directory, env: { ...process.env, PULLBOARD_TEST_REUSE: '0' },
  })).then(result => { finished = true; return result; });
  outcome.catch(error => { failure = error; finished = true; });
  await waitForCondition(() => {
    if (failure) throw failure;
    if (finished && !existsSync(marker)) throw new Error('the real runner exited without waiting for its owned child');
    return existsSync(marker);
  }, 'the actual worker to enter child cleanup', { signal: t.signal });
  assert.equal(finished, false, 'the runner remains active while its child is held');
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { phase: 'waiting', children: 1,
    pids: [Number(readFileSync(marker + '.writer', 'utf8'))] }, 'cleanup owns the actual fixture writer');
  writeFileSync(release, 'finish');
  const result = await outcome;
  assert.equal(result.status, 0, result.context + result.stdout);
  assert.match(result.stdout, /# fail 0/u);
  assert.doesNotMatch(result.stderr, /SANDBOX_CLEANUP_DEFERRED/u, result.context + result.stdout);
  assert.equal(readFileSync(done, 'utf8'), '32', 'all late writes finished');
  assert.deepEqual(JSON.parse(readFileSync(exiting, 'utf8')), { writerFinished: true }, 'the child closed before its worker exited');
  assert.equal(existsSync(readFileSync(sandboxFile, 'utf8')), false, 'the real runner removed its sandbox without a second fixture cleanup');
});

test('an unverified child keeps cleanup a warning and preserves the sandbox for the sweep [C7]', t => {
  const sandbox = mkdtempSync(join(tmpdir(), 'pullboard-cleanup-warning-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  writeFileSync(join(sandbox, TEST_CHILD_CLEANUP_FAILED), 'owned child close not observed\n');
  const lines = [];
  assert.equal(removeTestSandbox(sandbox, text => lines.push(text)), false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /SANDBOX_CLEANUP_DEFERRED.*owned child still running/u);
  assert.equal(existsSync(sandbox), true, 'cleanup does not race an unverified writer');
});
