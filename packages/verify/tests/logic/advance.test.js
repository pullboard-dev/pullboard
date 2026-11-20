/** @pullboard-test-input apps/runner/src/io/worker.js packages/codemap/data/plan/51-app-runner.json */
/** Two loaded copies of the runner worker's front door each own their handles, timers and flags [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effectiveItemHead as indexEffectiveItemHead } from '../../index.js';
import { effectiveItemHead as lightEffectiveItemHead } from '../../light.js';
import { gateJudgmentPath } from '../../index.js';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runFixtureChild } from '../../../../apps/cli/tests/fixtures/child.js';

const FRONT_DOOR = pathToFileURL(resolve(import.meta.dirname, '../../../../apps/runner/src/io/worker.js')).href;

/** The probe loads the worker body twice, the second time under a query suffix, starts each by calling runnerWorker, and mutates only the first copy. */
const PROBE = `
const request = Buffer.from(JSON.stringify({ nonce: '00000000-0000-0000-0000-000000000000', root: process.argv[2] })).toString('base64');
process.argv[2] = '--health'; process.argv[3] = request;
const a = await import(${JSON.stringify(FRONT_DOOR)});
const b = await import(${JSON.stringify(FRONT_DOOR + '?copy=2')});
a.runnerWorker(process.argv);
b.runnerWorker(process.argv);
const { beginCleanup } = await import(new URL('./worker/cleanup.js', ${JSON.stringify(FRONT_DOOR)}).href);
const { installSignalCustody } = await import(new URL('./worker/process.js', ${JSON.stringify(FRONT_DOOR)}).href);
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

test('verify.advance.copy-state: a second copy of the worker front door keeps its own process state, not the first copy\'s [C7]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-worker-state-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const probe = join(directory, 'probe.mjs');
  writeFileSync(probe, PROBE);
  const child = runFixtureChild(process.execPath, [probe, join(directory, 'runner-root')], { encoding: 'utf8', cwd: directory });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(/^REPORT (.*)$/mu.exec(child.stdout)[1]);
  assert.deepEqual(report, { distinct: true, collections: true, timers: true, custody: true, goneA: 'settled', goneB: 'pending' });
  assert.equal(child.stdout.match(/"worker":true/gu).length, 2, 'each copy ran its own dispatch when called');
});

/** Existing review authority follows every moved runner body [C7]. */
test('verify.advance.strict-review: runner move preserves strict review for every strict planned source [C7]', () => {
  const plan = JSON.parse(readFileSync(new URL('../../../codemap/data/plan/51-app-runner.json', import.meta.url), 'utf8'));
  const strict = plan.paths.filter(([old]) => gateJudgmentPath(old));
  assert.ok(strict.length > 0, 'the plan includes existing strict paths');
  for (const [old, moved] of strict) assert.equal(gateJudgmentPath(moved), true, old);
  assert.equal(gateJudgmentPath('apps/view/src/logic/ordinary.js'), false, 'unrelated app paths stay outside strict');
});

/** A board holding only the rows effectiveItemHead reads: the recorded source-advance chain, if any, and its submission episode [C7]. */
function advanceBoard(chain) {
  const rows = (sql, key) => {
    if (sql.includes('FROM board_meta')) return String(key).startsWith('item_source_advance:') && chain ? { meta_value: JSON.stringify({ version: 1, chain }) } : undefined;
    return sql.includes("event_kind IN ('submit'") ? { event_id: 7 } : undefined;
  };
  return { db: { prepare: sql => ({ get: key => rows(sql, key) }) } };
}

/** The light door answers as the index door does, so a light caller no longer needs the heavy front door [C7]. */
test('verify.logic-advance.light-door-exports-effective-item-head: the light door exports the index door\'s effectiveItemHead and agrees on an advanced and an unadvanced item [C7]', () => {
  assert.equal(lightEffectiveItemHead, indexEffectiveItemHead, 'one function behind both doors');
  const item = { item_id: 5, item_commit: 'submitted-sha', item_frozen_digest: 'bar-digest' };
  const advanced = advanceBoard([{ submitted: 'submitted-sha', bar: 'bar-digest', patchDigest: null, episode: 7, eventId: 9, head: 'advanced-head', verdict: 1, phases: [], trunk: 't', paths: [] }]);
  assert.equal(lightEffectiveItemHead(advanced, item), 'advanced-head');
  assert.equal(indexEffectiveItemHead(advanced, item), 'advanced-head');
  const plain = advanceBoard(null);
  assert.equal(lightEffectiveItemHead(plain, item), null);
  assert.equal(indexEffectiveItemHead(plain, item), null);
});
