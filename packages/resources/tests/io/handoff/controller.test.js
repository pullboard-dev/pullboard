/** @pullboard-test-input packages/resources/index.js packages/resources/src/io/handoff/worker/cap.js */
/** The machine dispatcher and gate drive are deleted; resources dispatches no gate by controller [C7,#6579]. */
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
