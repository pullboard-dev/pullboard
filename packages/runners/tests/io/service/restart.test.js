/** install-serve restarts a serve its bootout left running, once the new app folder is in place, so new runner code takes effect [P7,#10839]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runnerServiceInstaller } from '../../../src/io/service.js';
import { SERVICE_LABEL } from '../../../src/io/service.js';
import { STAND_IN_SERVE } from '../../fixtures/stand-in-serve.js';
import { startStandInServe } from '../../fixtures/stand-in-serve.js';

/** A throwaway HOME, a fake launchctl that only logs, and an install root; no real launchctl runs. */
function fixture(t) {
  const base = privateFixtureFiles('pb10839-').root;
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = join(base, 'bin'), home = join(base, 'home');
  mkdirSync(bin); mkdirSync(home);
  writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'launchctl'), 0o755);
  return { base, bin, home, root: join(base, 'root') };
}

/** Run the installer in this process with the fixture's PATH and HOME and return its JSON reply. */
async function install(t, { bin, home, root }) {
  const plan = { label: SERVICE_LABEL, root, remove: false, board: 'http://127.0.0.1:1/api/v1/boards/b', key: 'k', entry: 'svc.cjs', files: { 'svc.cjs': STAND_IN_SERVE, 'marker.txt': 'new' } };
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME }, stdin = Object.getOwnPropertyDescriptor(process, 'stdin'), write = process.stdout.write;
  let out = '';
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, HOME: home });
  Object.defineProperty(process, 'stdin', { value: Readable.from([Buffer.from(JSON.stringify(plan))]), configurable: true });
  process.stdout.write = chunk => { out += String(chunk); return true; };
  try { await runnerServiceInstaller(); } finally { Object.assign(process.env, saved); Object.defineProperty(process, 'stdin', stdin); process.stdout.write = write; }
  return JSON.parse(out.trim().split('\n').at(-1));
}

/** Resolve the exit, or null when the process is still running after `ms`. */
const within = (exited, ms) => Promise.race([exited, new Promise(done => setTimeout(() => done(null), ms))]);

test('runners.restart.stale-serve-gets-sigterm: clause 1: install-serve sends SIGTERM to this user\'s serve running <root>/serve/app/<entry> that its bootout left running, after the new app folder is in place, and names its pid in restarted [P7,#10839]', { timeout: 60_000 }, async t => {
  const paths = fixture(t), seen = join(paths.base, 'seen.txt');
  const { pid, exited } = await startStandInServe(t, paths.root, seen);
  const reply = await install(t, paths);
  assert.deepEqual(reply.restarted, [pid]);
  assert.ok(await within(exited, 10_000), 'the stale serve ended on SIGTERM');
  assert.equal(readFileSync(seen, 'utf8'), 'new', 'the new app folder was in place before the SIGTERM');
});

test('runners.restart.other-serves-left-alone: clause 2: a serve of another install folder keeps running and is not named, and an install with no serve of its own replies restarted [] [P7,#10839]', { timeout: 60_000 }, async t => {
  const paths = fixture(t), other = fixture(t);
  const { pid, exited } = await startStandInServe(t, other.root, join(other.base, 'seen.txt'));
  const reply = await install(t, paths);
  assert.deepEqual(reply.restarted, []);
  assert.equal(await within(exited, 1_500), null, `the other install's serve ${pid} keeps running`);
});
