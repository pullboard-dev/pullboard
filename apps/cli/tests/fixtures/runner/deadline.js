/** Shared real SSH stand-in fixture for the runner deadline journeys, split so each file stays under its time budget [C7,Q1,Q2]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from '../e2e.js';
import { cleanupFixtureChildren } from '../child.js';
import {
  cleanupToolingSnapshots,
  cli,
  fixtureResultContext,
} from './tooling.js';
import {
  HOST,
  installSshStandIn,
} from './ssh.js';
import { listResources } from '../../../../../packages/resources/index.js';

export const e2e = createE2eHelpers();
// budget: measured stand-in boot allowance already used by runner-transport-lost; the actual deadline and fallback assertions remain exercised.
export const STAND_IN_BOOT_BUDGET_MS = 8_000;
// budget: a ceiling, never a wait: a passing phase returns as soon as its marker lands; runners at twice their cores took 8-14 s to reach the stand-in.
export const STAND_IN_CEILING_MS = 45_000;
after(e2e.cleanup);
after(cleanupFixtureChildren);
after(cleanupToolingSnapshots);

/** Build the real loopback SSH transport in an isolated machine, with a short private deadline. */
export function fixture({ hold = '', runnerWaitMs = 60, dropFirst = !hold, healthDown = false, transportDown = healthDown } = {}) {
  const box = e2e.project('true');
  const paths = Object.fromEntries(['bin', 'worker', 'remoteHome', 'remoteMachine'].map(name => [name, join(box.dir, name)]));
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  const requests = join(box.dir, 'requests.jsonl');
  const starts = join(box.dir, 'starts.jsonl');
  const stderrLog = join(box.dir, 'worker-stderr.log');
  // The registration probe reads this machine's desktop; pin it to no desktop, as the runner's fixture host has (#1599).
  const noDesktop = join(box.dir, 'no-desktop-preload.cjs');
  writeFileSync(noDesktop, `const cp=require('node:child_process');const original=cp.spawnSync;
cp.spawnSync=function(command,...args){ if(command!=='/bin/launchctl') return original.call(this,command,...args);
  return {status:113,signal:null,stderr:'Could not find domain for fixture\\n'}; };
require('node:module').syncBuiltinESMExports();\n`);
  installSshStandIn({ bin: paths.bin, worker: paths.worker, home: paths.remoteHome,
    machineHome: paths.remoteMachine, requests, starts, hold, dropFirst, healthDown: transportDown, workerHealthDown: healthDown, stderrLog,
    registrationNodeOptions: `--require=${noDesktop}` });
  box.env.PATH = paths.bin + ':' + box.env.PATH;
  const added = cli(box.repo, box.env, 'runner', 'add', HOST + '-drop', '--slots', '1', '--browser', '1');
  assert.equal(added.status, 0, fixtureResultContext(added));
  const settingsFile = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  writeFileSync(settingsFile, JSON.stringify({ ...settings, gateSlots: 1, browserSlots: 1,
    // Pinned off: the default load-aware dispatch (4a04010085) reads the busy test machine through the stand-in and can refuse the fixture runner.
    gate: { ...settings.gate, runnerWaitMs, runnersFirst: false, loadAwareDispatch: false } }));
  return { ...box, requests, starts, stderrLog, settingsFile };
}

/**
 * Observe a real fixture phase, with cleanup owned by the caller rather than a production timeout override.
 * An infrastructure requeue renews the runner deadline by design (#1953), so a phase that follows one passes
 * a budget covering the admission deadline plus the renewed one.
 */
export async function observe(predicate, description, budgetMs = STAND_IN_CEILING_MS) {
  const until = Date.now() + budgetMs; // budget: private Git and SSH startup; no production deadline extension.
  while (!predicate()) {
    if (Date.now() >= until) throw new Error('fixture did not reach ' + description);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}


/** Run one isolated real pool case without changing the invoking machine's resource settings. */
export async function withPrivateDeadlineMachine(box, action) {
  const keys = ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME'];
  const previous = keys.map(key => process.env[key]);
  for (const key of keys) process.env[key] = box.env[key];
  try { return await action(JSON.parse(readFileSync(box.settingsFile, 'utf8'))); }
  finally { keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
  }); }
}

/** Read only the bounded tail of an existing private diagnostic, never a whole result packet. */
export function diagnosticTail(file) {
  if (!existsSync(file)) return '';
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, 16_384));
    const length = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    return bytes.subarray(0, length).toString('utf8');
  } finally { closeSync(fd); }
}

/** On failure retain actual setup/transport evidence without printing native result/base64 bodies. */
export function lateDispatchDiagnostics(box) {
  const stderr = diagnosticTail(box.stderrLog).split('\n');
  console.error('late private worker diagnostics:', stderr.filter(line => !line.startsWith('PULLBOARD_RUNNER_RESULT ')
    && !line.startsWith('PULLBOARD_RUNNER_NEED ')).slice(-8).map(line => line.slice(0, 500)).join('\n'));
  const outcomes = diagnosticTail(box.requests).split('\n').filter(Boolean).slice(-4).map(line => {
    try {
      const { call, workerStarted, code, signal, dropped, spawnError } = JSON.parse(line);
      return { call, workerStarted, code, signal, dropped, spawnError };
    } catch { return { incomplete: true }; }
  });
  console.error('late private worker outcomes:', outcomes);
  console.error('late private worker phases:', diagnosticTail(box.requests + '.phases').slice(-500));
  const pool = listResources({ scope: 'machine' }).find(row => row.name === 'gate');
  console.error('late private gate state:', { holders: pool?.holders.length, waiters: pool?.line.length });
}
