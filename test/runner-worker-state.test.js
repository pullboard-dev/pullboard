/** @pullboard-test-input source-tree */
/** Two loaded copies of the runner worker's front door each own their handles, timers and flags [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runFixtureChild } from './fixture-child.js';

const FRONT_DOOR = pathToFileURL(resolve(import.meta.dirname, '../src/runner-worker.js')).href;

/** The probe loads the front door twice, the second time under a query suffix, and mutates only the first copy. */
const PROBE = `
const request = Buffer.from(JSON.stringify({ nonce: '00000000-0000-0000-0000-000000000000', root: process.argv[2] })).toString('base64');
process.argv[2] = '--health'; process.argv[3] = request;
const a = await import(${JSON.stringify(FRONT_DOOR)});
const b = await import(${JSON.stringify(FRONT_DOOR + '?copy=2')});
const { beginCleanup } = await import(new URL('./runner-worker-cleanup.js', ${JSON.stringify(FRONT_DOOR)}).href);
const { installSignalCustody } = await import(new URL('./runner-worker-process.js', ${JSON.stringify(FRONT_DOOR)}).href);
const A = a.workerState, B = b.workerState;
const report = {};
report.distinct = A !== B && A.ownedChildren !== B.ownedChildren && A.setupPrivatePaths !== B.setupPrivatePaths && A.transportGone !== B.transportGone;
A.setupPrivatePaths.add('/x'); A.workerId = 'a'; A.ownedChildren.set({}, {});
report.collections = B.setupPrivatePaths.size === 0 && B.workerId === 'starting' && B.ownedChildren.size === 0;
beginCleanup(A);
report.timers = A.cleanupTimer !== null && Number.isFinite(A.cleanupDeadline) && B.cleanupTimer === null && B.cleanupDeadline === Infinity;
clearTimeout(A.cleanupTimer);
installSignalCustody(A);
report.custody = A.signalCustodyInstalled === true && B.signalCustodyInstalled === false;
A.markTransportGone();
report.goneA = await Promise.race([A.transportGone.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('pending'), 50))]);
report.goneB = await Promise.race([B.transportGone.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('pending'), 50))]);
clearInterval(A.heartbeatTimer);
console.log('REPORT ' + JSON.stringify(report));
`;

test('a second copy of the worker front door keeps its own process state, not the first copy\'s [C7]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-worker-state-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const probe = join(directory, 'probe.mjs');
  writeFileSync(probe, PROBE);
  const child = runFixtureChild(process.execPath, [probe, join(directory, 'runner-root')], { encoding: 'utf8', cwd: directory });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(/^REPORT (.*)$/mu.exec(child.stdout)[1]);
  assert.deepEqual(report, { distinct: true, collections: true, timers: true, custody: true, goneA: 'settled', goneB: 'pending' });
  assert.equal(child.stdout.match(/"worker":true/gu).length, 2, 'each copy ran its own dispatch');
});
