/** @pullboard-test-input source-cell apps/cli */
/** @pullboard-test-loads apps/cli/src/io/entry.js */
/** The registered-worker submit case against a fixture runner, alone in its file so its add and submit gate runs get a file budget of their own; its submit settles through the registered pull runner [C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { HOST } from '../../../../packages/gate/tests/fixtures/runner/ssh.js';
import { fixtureAdd } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { registerStandInAfterAdd } from '../../tests/fixtures/runner/registered.js';
import { serveRegisteredRunner } from '../../tests/fixtures/runner/registered.js';
import { settledGateJob } from '../../tests/fixtures/submit/settle.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Require native CLI success before using any fixture result as setup evidence. */
function succeeded(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return result;
}

test('cli.journeys-resources-submit.opt-in-native-submit-uses-a: clause 1: opt-in native submit uses a real registered worker even with free local capacity [C7,V4]', async t => {
  const t0 = Date.now(), tick = label => process.stderr.write(`TIMING ${((Date.now() - t0) / 1000).toFixed(1)}s ${label}\n`);
  const box = helpers.project('true');
  const requests = join(box.dir, 'runner-only-requests.jsonl');
  const registered = await registerStandInAfterAdd(box, { requests, add: () => {
    const added = succeeded(fixtureAdd(box.run, box.repo, 'web', 'Registered runner-only submission', '--specs', 'G1',
      '--criterion', 'The native frozen check executes in its admitted registered worker.',
      '--check', 'printf RUNNER_ONLY_FROZEN_BODY', '--wait', '--json'));
    tick('after add --wait');
    return added;
  } });
  tick('after runner add');
  const id = JSON.parse(registered.added.out).item.item_id;
  succeeded(await box.runAsync(box.web, 'claim', String(id), '--json'));
  tick('after claim');
  const built = await helpers.commitFile(box, box.web, 'web/registered.txt', 'actual worker control\n', 'feat(web): registered runner-only control [G1]');
  assert.equal(built.status, 0, built.failure ?? built.stderr);
  tick('after commit');
  succeeded(await box.runAsync(box.repo, 'settings', 'gate.runnersOnly', 'on'));
  const settings = JSON.parse(succeeded(await box.runAsync(box.repo, 'settings', '--json')).out).settings;
  assert.ok(settings.gateSlots > 0, 'local capacity remains available throughout this control');
  assert.equal(settings.gate.runnersFirst, false, 'runner-only does not depend on runner-first preference');
  const runner = await serveRegisteredRunner(t, box, registered);
  tick('after settings and registered runner');
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const queued = JSON.parse(succeeded(await box.runAsync(box.web, 'submit', String(id), '--wait', '--no-next', '--json')).out);
  tick('after submit --wait');
  const job = await settledGateJob(box, id, { deadlineMs: 60_000 });
  tick('after gate settled');
  assert.equal(job.id, queued.gateJob, 'the job the submit offered is the one that settled');
  assert.equal(job.gate?.green, true, JSON.stringify(job).slice(0, 2000));
  assert.equal(job.gate.logRunner, HOST, 'the registered runner served the job');
  assert.ok(job.gate.logPath.startsWith(`${runner.folder}/`), `the job ran under the registered runner home ${runner.folder}: ${job.gate.logPath}`);
  assert.deepEqual(job.gate.phases.find(phase => phase.role === 'check').tail, 'RUNNER_ONLY_FROZEN_BODY', 'the frozen check body ran in the registered runner');
  assert.equal(job.gate.source, commit, 'the registered runner judged the submitted commit');
  const calls = existsSync(requests) ? readFileSync(requests, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)) : [];
  assert.ok(calls.every(call => call.host === HOST && !call.remoteHasSecret), 'every ssh call the stand-in saw was to the registered host and carried no secret');
});
