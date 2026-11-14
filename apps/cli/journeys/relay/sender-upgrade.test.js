/** An upgraded install replaces the relay sender an older pullboard started, and doctor and recover name it [H21,H16,C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  nudgeRelaySender,
  outdatedSender,
  senderFiles,
} from '../../../../packages/link/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/light.js';
import { SENDER_WORKER } from '../../index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

/**
 * A live sender process the way an older pullboard leaves one: it holds the machine's claim and keeps it fresh, and
 * writes an engine record only when given one (0.9.3 wrote none). Why a stand-in: the real 0.9.3 worker needs the
 * whole 0.9.3 tree; what this version must act on is only the claim it leaves behind.
 */
async function runningSender(t, home, engine) {
  const directory = join(home, 'relay-sender');
  mkdirSync(directory, { recursive: true });
  const script = `
    const { writeFileSync, utimesSync } = require('node:fs');
    const pid = ${JSON.stringify(join(directory, 'sender.pid'))};
    ${engine === undefined ? '' : `writeFileSync(${JSON.stringify(join(directory, 'sender.engine'))}, process.pid + ' ' + ${engine} + '\\n');`}
    writeFileSync(pid, process.pid + '\\n');
    setInterval(() => utimesSync(pid, new Date(), new Date()), 500);
    setTimeout(() => process.exit(0), 60000);
    process.stdout.write('claimed\\n');`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const claimed = await new Promise(resolve => {
    child.stdout.once('data', () => resolve(true));
    child.once('exit', () => resolve(false));
  });
  child.stdout.resume();
  assert.ok(claimed, 'the stand-in sender claimed the machine');
  assert.equal(Number(readFileSync(join(directory, 'sender.pid'), 'utf8')), child.pid);
  return { child, exited };
}

/** Run with this test's own machine home and the background sender on, then restore the process environment. */
async function withHome(t, work) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const home = helpers.sandbox().env.PULLBOARD_HOME;
  mkdirSync(home, { recursive: true });
  const saved = { home: process.env.PULLBOARD_HOME, background: process.env.PULLBOARD_RELAY_SENDER_BACKGROUND };
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_RELAY_SENDER_BACKGROUND = '1';
  try { return await work(home); }
  finally {
    if (saved.home === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = saved.home;
    if (saved.background === undefined) delete process.env.PULLBOARD_RELAY_SENDER_BACKGROUND; else process.env.PULLBOARD_RELAY_SENDER_BACKGROUND = saved.background;
  }
}

test('clause 1: a move after the upgrade stops the 0.9.3 sender and starts this version\'s, so the outbox is served [H21,H16,C7]', async t => {
  await withHome(t, async home => {
    const old = await runningSender(t, home);
    assert.deepEqual(outdatedSender(), { pid: old.child.pid, engine: null, current: ENGINE_VERSION }, 'a sender with no engine record is outdated');
    const launched = [];
    nudgeRelaySender(join(home, 'board'), join(home, 'board', 'relay.json'), root => launched.push(root));
    assert.equal((await old.exited).signal, 'SIGTERM', 'the 0.9.3 sender is stopped');
    assert.deepEqual(launched, [join(home, 'board')], 'this version\'s sender is started in its place');
    assert.equal(existsSync(senderFiles().pid), false, 'the old claim is given up at once');
  });
});

test('clause 1: an older engine record is replaced, a current one is left running [H21,H16,C7]', async t => {
  await withHome(t, async home => {
    const older = await runningSender(t, home, ENGINE_VERSION - 1);
    const launched = [];
    nudgeRelaySender(home, join(home, 'relay.json'), root => launched.push(root));
    assert.equal((await older.exited).signal, 'SIGTERM');
    assert.equal(launched.length, 1);
    rmSync(senderFiles().starting, { force: true });
    const current = await runningSender(t, home, ENGINE_VERSION);
    nudgeRelaySender(home, join(home, 'relay.json'), root => launched.push(root));
    assert.equal(outdatedSender(), null);
    assert.equal(launched.length, 1, 'a current sender keeps the machine');
    assert.equal(current.child.exitCode, null, 'a current sender keeps running');
  });
});

test('clause 1: this version\'s sender records its engine with its claim [H21,H16,C7]', async t => {
  await withHome(t, async home => {
    // No board waits, so the real sender claims, finds nothing to send and exits.
    const child = spawn(process.execPath, [SENDER_WORKER], { cwd: home, stdio: 'ignore', env: { ...process.env, PULLBOARD_HOME: home } });
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 0);
    assert.equal(readFileSync(senderFiles().engine, 'utf8'), `${child.pid} ${ENGINE_VERSION}\n`);
  });
});

test('clause 2: doctor names the old sender with relay recover, and relay recover replaces it [H21,H16,C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  const old = await runningSender(t, box.env.PULLBOARD_HOME);
  const before = await runCliInProcess(['doctor'], { cwd: box.repo, env: box.env });
  assert.equal(before.code, 1, before.out + before.err);
  assert.match(before.out, new RegExp(`problem: the relay sender \\(process ${old.child.pid}\\) was started by an older pullboard \\(no engine recorded; this one is engine ${ENGINE_VERSION}\\).*; repair: run pullboard relay recover`, 'u'));
  const recovered = await runCliInProcess(['relay', 'recover'], { cwd: box.repo, env: box.env });
  assert.equal(recovered.code, 0, recovered.out + recovered.err);
  assert.match(recovered.out, new RegExp(`relay recovery replaced the old relay sender: the relay sender \\(process ${old.child.pid}\\)`, 'u'));
  assert.equal((await old.exited).signal, 'SIGTERM');
  const after = await runCliInProcess(['doctor'], { cwd: box.repo, env: box.env });
  assert.doesNotMatch(after.out, /started by an older pullboard/u, after.out);
});

test('clause 2: relay recover with no old sender still refuses as before [H21,C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  const result = await runCliInProcess(['relay', 'recover'], { cwd: box.repo, env: box.env });
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.out, /replaced the old relay sender/u);
});
