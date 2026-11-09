/** Process identity probes run off the event loop and answer exactly as the synchronous read does [C7,#3837]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { warmProcessIdentities } from '../packages/resources/index.js';
import { PS_IDENTITY_ARGS } from '../packages/resources/src/shell/holder-liveness.js';
import { PS_IDENTITY_ENV } from '../packages/resources/src/shell/holder-liveness.js';
import { parsePsIdentity } from '../packages/resources/src/shell/holder-liveness.js';
import { processIdentityAsync } from '../packages/resources/src/shell/holder-liveness.js';

/** The identity the synchronous read gives: the same ps call, run blocking. */
function syncIdentity(pid) {
  try {
    return parsePsIdentity(execFileSync('/bin/ps', [...PS_IDENTITY_ARGS, String(pid)], { encoding: 'utf8', env: { ...process.env, ...PS_IDENTITY_ENV }, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return null; }
}

test('clause 1: a probe that is still running leaves the event loop free, so other timers and callbacks keep running while it runs [C7]', async () => {
  let turns = 0, stopped = false;
  /** Another part of the process asking for the loop: it only advances while nothing blocks it. */
  const spin = () => { turns += 1; if (!stopped) setImmediate(spin); };
  setImmediate(spin);
  let turnsDuringProbe = 0;
  // A probe standing in for ps at load: it finishes only after the loop has turned three times while it was pending.
  const probe = async () => {
    while (turns < 3) await new Promise(resolve => setImmediate(resolve));
    turnsDuringProbe = turns;
    return { started: 'stub', zombie: false };
  };
  try { await warmProcessIdentities([process.pid + 100_000], { probe }); }
  finally { stopped = true; }
  assert.ok(turnsDuringProbe >= 3, 'the loop turned while the probe was pending');
});

test('clause 1: the real ps probe runs as a child process and resolves an identity for a live process [C7]', async () => {
  const identity = await processIdentityAsync(process.pid);
  assert.equal(typeof identity?.started, 'string');
  assert.equal(identity.zombie, false);
});

test('clause 2: the asynchronous read answers exactly as the synchronous read for a live process, a reused-looking pid and a gone process [C7]', async () => {
  assert.deepEqual(await processIdentityAsync(process.pid), syncIdentity(process.pid), 'this process');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    assert.deepEqual(await processIdentityAsync(child.pid), syncIdentity(child.pid), 'a live child');
  } finally { child.kill(); await once(child, 'exit'); }
  assert.deepEqual(await processIdentityAsync(child.pid), syncIdentity(child.pid), 'a process that has exited');
});
