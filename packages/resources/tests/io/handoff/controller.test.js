/** @pullboard-test-input packages/resources/index.js packages/resources/src/io/handoff/worker/cap.js */
/** The machine dispatcher, gate drive, handoff worker, its cap and lifeline are deleted; nothing starts them [C7,#6579,#6580]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as resources from '../../../index.js';

const REPO = join(import.meta.dirname, '../../../../..');

/** Every JavaScript source file under packages/resources/src, as repo-relative paths. */
function resourceSources() {
  const root = join(REPO, 'packages/resources/src');
  return readdirSync(root, { recursive: true })
    .filter(name => String(name).endsWith('.js'))
    .map(name => join('packages/resources/src', String(name)));
}

test('clause 1: apps/lib/src/io/handoff/dispatcher.js and apps/cli/src/io/gate/drive.js are gone [C7]', () => {
  for (const file of ['apps/lib/src/io/handoff/dispatcher.js', 'apps/cli/src/io/gate/drive.js']) {
    assert.equal(existsSync(join(REPO, file)), false, `${file} still exists`);
  }
});

test('clause 2: resources exports no dispatch entry and no resources source launches the dispatcher or gate drive [C7]', () => {
  for (const name of ['drainHandoffQueue', 'ensureHandoffDispatcher', 'recoverHandoffDispatcher', 'handoffDispatcherMayBeDead', 'finishRunningWorkers', 'repeatingSweep']) {
    assert.equal(name in resources, false, `resources still exports ${name}`);
  }
  for (const file of ['packages/resources/src/io/handoff/recovery.js']) assert.equal(existsSync(join(REPO, file)), false, `${file} still exists`);
  const launchers = /gate\/drive\.js|handoff\/dispatcher\.js|worker\/detach\.js/u;
  const offenders = resourceSources()
    .filter(file => !file.endsWith('worker/detach.js'))
    .filter(file => launchers.test(readFileSync(join(REPO, file), 'utf8')));
  assert.deepEqual(offenders, []);
});

/** Every tracked JavaScript source file outside tests, fixtures and the frozen rename plan. */
function trackedSources() {
  const roots = ['apps', 'packages', 'bin'].map(root => join(REPO, root)).filter(existsSync);
  return roots.flatMap(root => readdirSync(root, { recursive: true }).map(name => join(root, String(name))))
    .filter(file => file.endsWith('.js') && !/\/(tests|journeys|fixtures|node_modules)\//u.test(file));
}

test('#6580 clause 1: apps/cli/src/io/submit/handoff/worker.js is gone [C7]', () => {
  for (const file of ['apps/cli/src/io/submit/handoff/worker.js', 'packages/runners/src/io/handoff/capacity.js']) {
    assert.equal(existsSync(join(REPO, file)), false, `${file} still exists`);
  }
});

test('#6580 clause 2: no code path starts the handoff worker cap or the lifeline [C7]', () => {
  for (const name of ['onDispatcherLifelineEnd', 'releaseLifelines', 'handoffWorkerCapacity', 'handoffWorkerCapacityDetail', 'recordHandoffCap', 'handoffCapLine', 'HANDOFF_WORKER_LIFELINE_ENV', 'HANDOFF_LIFELINE_RELEASE', 'HANDOFF_WORKER_RESOURCE']) {
    assert.equal(name in resources, false, `resources still exports ${name}`);
  }
  const starters = /submit\/handoff\/worker\.js|onDispatcherLifelineEnd|releaseLifelines|handoffWorkerCapacity|driveSubmitHandoff|submitHandoffWorker/u;
  const offenders = trackedSources().filter(file => starters.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});
