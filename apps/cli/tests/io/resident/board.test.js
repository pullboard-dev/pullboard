/** @pullboard-test-input source-tree */
/**
 * The resident client sends test --status to the resident process and frees a slot whose command is wedged past the
 * per-command ceiling [C7,#5470]. On 10 Nov all four slots held commands hung for 3-11 h, so every call ran cold.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  RESIDENT_COMMAND_CEILING_MS,
  RESIDENT_WEDGED_GRACE_MS,
  residentBusy,
  residentBusyFile,
  residentCommand,
  residentCommandCeiling,
} from '../../../src/io/resident/client.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

const dir = privateFixtureFiles('pb-ceiling-').root;
after(() => rmSync(dir, { recursive: true, force: true }));

test('clause 2: test --status is a resident command; a test run, --wait and --test-run are not [C7,#5470]', () => {
  assert.equal(residentCommand(['test', '--status', 'abc']), true);
  assert.equal(residentCommand(['test', '--status=abc']), true);
  assert.equal(residentCommand(['test', 'a.test.js']), false);
  assert.equal(residentCommand(['test', '--test-run', 'abc', '--status', 'abc']), false);
  assert.equal(residentCommand(['test', '--status', 'abc', '--wait']), false);
  assert.equal(residentCommand(['test', '--status', 'abc', '--as', 'person']), false);
  assert.equal(residentCommand(['show', '1']), true);
});

test('clause 1: the ceiling defaults to 60 s and PULLBOARD_RESIDENT_COMMAND_MS overrides it [C7,#5470]', () => {
  assert.equal(residentCommandCeiling({}), RESIDENT_COMMAND_CEILING_MS);
  assert.equal(RESIDENT_COMMAND_CEILING_MS, 60_000);
  assert.equal(residentCommandCeiling({ PULLBOARD_RESIDENT_COMMAND_MS: '1500' }), 1500);
  assert.equal(residentCommandCeiling({ PULLBOARD_RESIDENT_COMMAND_MS: 'x' }), RESIDENT_COMMAND_CEILING_MS);
});

test('clause 1: a slot whose command ran past the ceiling is wedged: its process is ended and the slot reads free [C7,#5470]', async () => {
  const pidFile = join(dir, 'w.pid');
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const exited = new Promise(done => holder.on('exit', done));
  writeFileSync(pidFile, `${holder.pid}\n`);
  const busy = residentBusyFile(pidFile);
  const now = Date.now();
  try {
    writeFileSync(busy, `${holder.pid} ${now - 5_000}\n`);
    assert.equal(residentBusy(pidFile, now), true, 'a command inside the ceiling keeps its slot busy');
    writeFileSync(busy, `${holder.pid} ${now - RESIDENT_COMMAND_CEILING_MS - RESIDENT_WEDGED_GRACE_MS - 1}\n`);
    assert.equal(residentBusy(pidFile, now), false, 'a command past the ceiling frees the slot');
    await exited;
    assert.equal(existsSync(busy), false);
    assert.equal(existsSync(pidFile), false);
  } finally { holder.kill('SIGKILL'); }
});

test('clause 1: a busy file naming a process the pid file does not name is never signalled [C7,#5470]', async () => {
  const pidFile = join(dir, 'x.pid');
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  writeFileSync(pidFile, '999999\n');
  writeFileSync(residentBusyFile(pidFile), `${bystander.pid} ${Date.now() - 10 * 60_000}\n`);
  try {
    residentBusy(pidFile);
    assert.equal(bystander.exitCode, null);
    assert.doesNotThrow(() => process.kill(bystander.pid, 0));
  } finally { bystander.kill('SIGKILL'); }
});
