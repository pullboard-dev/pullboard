/** @pullboard-module-loads packages/gate/index.js packages/runners/index.js */
/** Exercise runner-first placement, zero local pools, and public submit/landing gate paths [C7]. */
import { executionServices } from '../gate/execution.js';
import { executionServicesSource } from '../gate/execution.js';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFixtureChild } from '../child.js';
import {
  HOST,
  installRegistrationProbeStandIn,
  installSshStandIn,
} from './ssh.js';
import { fixtureAdd } from '../testkit.js';

/** Ask the real private machine queue for one gate lease from a fresh process. */
function runPrivateGateLease(box, behavior = '') {
  const gateUrl = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/gate/index.js')).href;
  const runnersUrl = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/runners/index.js')).href;
  const source = `import { withGateSlot } from ${JSON.stringify(gateUrl)};
${executionServicesSource(gateUrl)}
import { RunnerDropped } from ${JSON.stringify(runnersUrl)};
const root = ${JSON.stringify(box.repo)};
let remoteAttempts = 0;
const result = await withGateSlot(root, async lease => {
  ${behavior}
  return lease.runner?.host ?? 'local';
}, { executionServices, remote: true, kind: 'runner-first-cursor-test' });
process.stdout.write(result + '\\n');
`;
  return runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env: box.env, encoding: 'utf8' });
}

/** Run the complete frozen runner-first policy scenario, including public submit and landing gate. */
export async function runnerFirstPolicyCase(e2e) {
  const box = e2e.privateCheckSubmission({ check: 'true' });
  const settingsFile = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  const probeBin = join(box.dir, 'registration-bin');
  mkdirSync(probeBin);
  installRegistrationProbeStandIn({ bin: probeBin });
  box.env.PATH = `${probeBin}:${box.env.PATH}`;
  // This case proves durable rotation, independently of the live-load ranking policy.
  const rotation = box.run(box.repo, 'settings', 'gate.loadAwareDispatch', 'off');
  assert.equal(rotation.code, 0, rotation.err);
  const hosts = ['a51', 'a52', 'a53'];
  for (const host of hosts) {
    const added = box.run(box.repo, 'runner', 'add', host, '--slots', '1', '--browser', '1');
    assert.equal(added.code, 0, `${host} is registered: ${added.err}`);
  }
  // With two or more runners the first is kept for timed checks by default; rotation needs every runner open to ordinary runs.
  const keptSettings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  writeFileSync(settingsFile, JSON.stringify({ ...keptSettings, gate: { ...keptSettings.gate, timingRunner: false } }));
  const first = box.run(box.repo, 'settings', 'gate.runnersFirst', 'on');
  assert.equal(first.code, 0, first.err);
  const browserZero = box.run(box.repo, 'settings', 'browserSlots', '0');
  assert.equal(browserZero.code, 0, `registered runners allow browserSlots 0: ${browserZero.err}`);
  const gateZero = box.run(box.repo, 'settings', 'gateSlots', '0');
  assert.equal(gateZero.code, 0, `registered runners allow gateSlots 0: ${gateZero.err}`);
  const effective = JSON.parse(box.run(box.repo, 'settings', '--json').out).settings;
  assert.equal(effective.gate.runnersFirst, true);
  assert.equal(effective.gateSlots, 0);
  assert.equal(effective.browserSlots, 0);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(() => {
    const result = runPrivateGateLease(box);
    assert.equal(result.status, 0, result.context);
    return result.stdout.trim();
  }), ['a51', 'a52', 'a53', 'a51', 'a52', 'a53'], 'the durable cursor rotates across fresh process requests');

  const priorHome = process.env.PULLBOARD_HOME;
  const priorMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  let releaseHeld;
  let heldRun;
  try {
    const { withGateSlot } = await import(pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/gate/index.js')).href);
    let announce;
    const admitted = new Promise(resolvePromise => { announce = resolvePromise; });
    heldRun = withGateSlot(box.repo, async lease => {
      announce(lease.runner?.host ?? 'local');
      await new Promise(resolvePromise => { releaseHeld = resolvePromise; });
      return lease.runner?.host ?? 'local';
    }, { executionServices, remote: true, agent: 'runner-first-full-control', kind: 'runner-first-cursor-test' });
    assert.equal(await admitted, 'a51', 'the first live runner lease occupies the next runner');
    assert.deepEqual([runPrivateGateLease(box), runPrivateGateLease(box)].map(result => {
      assert.equal(result.status, 0, result.context);
      return result.stdout.trim();
    }), ['a52', 'a53'], 'the cursor advances past the occupied host before returning to it');
    const skipped = runPrivateGateLease(box);
    assert.equal(skipped.status, 0, skipped.context);
    assert.equal(skipped.stdout.trim(), 'a52', 'a full next runner is skipped');
  } finally {
    releaseHeld?.();
    if (heldRun) await heldRun;
    if (priorHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = priorHome;
    if (priorMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = priorMachineHome;
  }

  const unreachable = runPrivateGateLease(box, `if (lease.runner?.host === 'a53') throw new RunnerDropped('a53');`);
  assert.equal(unreachable.status, 0, unreachable.context);
  assert.equal(unreachable.stdout.trim(), 'a51', 'an unreachable next runner is marked unavailable and skipped on its original queue request');

  const fallbackCapacity = box.run(box.repo, 'settings', 'gateSlots', '1');
  assert.equal(fallbackCapacity.code, 0, fallbackCapacity.err);
  const fallbackBrowser = box.run(box.repo, 'settings', 'browserSlots', '1');
  assert.equal(fallbackBrowser.code, 0, fallbackBrowser.err);
  // Every registered runner refuses once; with none reserved for timed checks that is one drop per host.
  const fallback = runPrivateGateLease(box, `if (lease.runner && remoteAttempts++ < ${hosts.length}) throw new RunnerDropped(lease.runner.host);`);
  assert.equal(fallback.status, 0, fallback.context);
  assert.equal(fallback.stdout.trim(), 'local', 'after registered runners refuse, runner-first uses the available local slot');

  const noRunner = e2e.privateCheckSubmission({ check: 'true' });
  const refusedGate = noRunner.run(noRunner.repo, 'settings', 'gateSlots', '0');
  assert.notEqual(refusedGate.code, 0);
  assert.match(refusedGate.err, /BAD_GATE_SLOTS/u);
  assert.match(refusedGate.err, /registered runner/u);
  const refusedBrowser = noRunner.run(noRunner.repo, 'settings', 'browserSlots', '0');
  assert.notEqual(refusedBrowser.code, 0);
  assert.match(refusedBrowser.err, /BAD_BROWSER_SLOTS/u);
  assert.match(refusedBrowser.err, /registered runner/u);
  assert.ok(readFileSync(settingsFile, 'utf8').includes('runnersFirst'), 'the opted-in policy is persisted only in the private fixture');

  // Public submit and landing-gate entry exercise the real worker transport. This does not claim
  // the coordinator-only `pullboard land` orchestration itself ran here.
  const integrated = e2e.project('true');
  const runner = HOST;
  const runnerBin = join(integrated.dir, 'submit-land-bin');
  const worker = join(integrated.dir, 'submit-land-worker');
  const remoteHome = join(integrated.dir, 'submit-land-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const requests = join(integrated.dir, 'submit-land-ssh-requests.jsonl');
  for (const folder of [runnerBin, worker, remoteHome, remoteMachineHome]) mkdirSync(folder, { recursive: true });
  integrated.env.PATH = `${runnerBin}:${integrated.env.PATH}`;
  installSshStandIn({ bin: runnerBin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  const registered = integrated.run(integrated.repo, 'runner', 'add', runner, '--slots', '1', '--browser', '1');
  assert.equal(registered.code, 0, registered.err);
  for (const [key, value] of [['gate.runnersFirst', 'on'], ['browserSlots', '0'], ['gateSlots', '0']]) {
    const setting = integrated.run(integrated.repo, 'settings', key, value);
    assert.equal(setting.code, 0, `${key} ${value}: ${setting.err}`);
  }
  const added = fixtureAdd(integrated.run, integrated.repo, 'web', 'Runner-first public submit', '--specs', 'G1',
    '--criterion', 'the runner executes the submitted gate', '--check', `${process.execPath} -e "setTimeout(() => {}, 1000)"`, '--wait', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(integrated.run(integrated.web, 'claim', String(id)).code, 0);
  const built = e2e.commitFile(integrated, integrated.web, 'web/runner-first.txt', 'submitted on runner\n', 'feat(web): add runner-first fixture [G1]');
  assert.equal(built.status, 0, built.stderr);
  const submittedCommit = integrated.git(integrated.web, 'rev-parse', 'HEAD');
  const submitted = integrated.run(integrated.web, 'submit', String(id), '--json');
  assert.equal(submitted.code, 0, `${submitted.out}\n${submitted.err}`);
  const submittedDocument = JSON.parse(submitted.out);
  const submitGateProfile = JSON.parse(readFileSync(submittedDocument.gate.check.profilePath, 'utf8'));
  const submitProofProfile = JSON.parse(readFileSync(submittedDocument.gate.proofProfilePath, 'utf8'));
  assert.equal(submitGateProfile.executionRunner, runner, 'public submit executes on the registered runner');
  assert.equal(submitGateProfile.executionSource?.commit, submittedCommit, 'the worker receipt binds the submitted check');
  assert.equal(submitGateProfile.receipt?.runner?.id, runner, 'the submit check records the actual runner admission receipt');
  assert.equal(submitProofProfile.executionSource?.commit, submittedCommit, 'the worker receipt binds the submitted proof');
  assert.equal(submitProofProfile.receipt?.runner?.id, runner, 'the submit proof records the actual runner admission receipt');

  const submitRequests = readFileSync(requests, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  assert.equal(submitRequests.length, 3, 'remote cell analysis, criterion and proof each make one actual SSH worker request');

  const landingGate = integrated.run(integrated.repo, 'gate', '--landing', '--json');
  assert.equal(landingGate.code, 0, `${landingGate.out}\n${landingGate.err}`);
  const landingProfile = JSON.parse(readFileSync(join(integrated.repo, '.git', 'pullboard-gate.log.profile.json'), 'utf8'));
  assert.equal(landingProfile.executionRunner, runner, 'the public landing gate uses the registered runner');
  assert.equal(landingProfile.executionSource?.commit, integrated.git(integrated.repo, 'rev-parse', 'HEAD'),
    'the landing-gate worker receipt binds the exact main source it checked');
  assert.equal(landingProfile.receipt?.runner?.id, runner, 'the landing gate records the actual runner admission receipt');
  const requestsMade = readFileSync(requests, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  assert.equal(requestsMade.length, 4, 'remote cell analysis, the two submit checks and landing each make one actual SSH worker request');
  assert.deepEqual(requestsMade.map(entry => entry.host), [runner, runner, runner, runner]);
  assert.ok(requestsMade.every(entry => entry.workerStarted && !entry.remoteHasSecret), 'every request executes the worker and keeps fixture secrets local');
}
