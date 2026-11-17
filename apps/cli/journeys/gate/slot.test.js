/**
 * End to end on real repos: submit and pre-push hold the machine gate slot until their check finishes (V4, B9, C3, Q1, Q2, Q4). Split from e2e.test.js to stay under two minutes.
 */
import assert from 'node:assert/strict';
import {
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { settleSubmit } from '../../tests/fixtures/submit/settle.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const { BIN, sandbox, project, holdingGate, launch, waitFor, gateEvents, commitFile } = e2e;

// Real processes on purpose: every launch() below is a live gate or git push that holds the machine gate slot, and the test
// proves the slot, its queue order and the children's exit. Only the short CLI calls beside them (settings, resources, claim) run through runIn (#8266).

test('submit needs a clean tree, nothing untracked, and the gate green at HEAD [V4, B9]', async (t) => {
  const box = project();
  fixtureAdd(box.run, box.repo, 'web', 'Page', '--specs', 'G1');
  assert.match((await box.runLocal(box.web, 'claim', '1')).out, /claimed #1/);
  await commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]');
  writeFileSync(join(box.web, 'web', 'a.html'), 'edited');
  assert.match((await box.runLocal(box.web, 'submit', '1')).err, /DIRTY/);
  box.git(box.web, 'checkout', '--', 'web/a.html');
  writeFileSync(join(box.web, 'web', 'stray.txt'), 'x');
  assert.match((await box.runLocal(box.web, 'submit', '1')).err, /UNTRACKED/);
  rmSync(join(box.web, 'web', 'stray.txt'));
  const sent = await box.runLocal(box.web, 'submit', '1', '--json');
  assert.equal(sent.code, 0, sent.err);
  // A pulled submit queues the whole gate; the local runner's receipt settles it and the pin follows [P7,V4].
  const submitted = await settleSubmit(t, { repo: box.repo, env: box.env, run: (cwd, ...args) => box.runLocal(cwd, ...args) }, JSON.parse(sent.out));
  assert.equal(submitted.gateJob.step, 'done');
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  assert.equal(box.git(box.repo, 'rev-parse', `refs/pullboard/items/1/${head.slice(0, 12)}`), head, 'submit pins the commit');
});

test('submit keeps its machine gate slot until the submitted check finishes [V4,Q4]', { skip: 'CONTROLLER_ONLY: deleted with #6832' }, async () => {
  const box = sandbox();
  const gate = holdingGate(box);
  const projectBox = project(gate.command, box);
  assert.equal((await projectBox.runIn(projectBox.repo, 'settings', 'gateSlots', '1')).code, 0);
  fixtureAdd(projectBox.run, projectBox.repo, 'web', 'Page', '--specs', 'G1');
  assert.match((await projectBox.runIn(projectBox.web, 'claim', '1')).out, /claimed #1/);
  assert.equal((await commitFile(projectBox, projectBox.web, 'web/page.html', 'page', 'feat(web): page [G1]')).status, 0);
  writeFileSync(gate.mode, 'armed');
  const children = [];
  try {
    const submitted = launch(projectBox, projectBox.web, process.execPath, [BIN, 'submit', '1']);
    children.push(submitted);
    await waitFor(() => gateEvents(gate).includes('start'), 'submit gate to start and hold its resource', 40_000); // budget: measured submit prep took 18 s under load; ceiling is a hang bound
    const competitor = launch(projectBox, projectBox.repo, process.execPath, [BIN, 'gate']);
    children.push(competitor);
    await waitFor(() => competitor.stdoutText.includes('place 1'), 'another gate to wait behind submit', 40_000); // budget: same ceiling as the submit gate start above; a loaded machine took over 8 s to start this second CLI
    assert.deepEqual(gateEvents(gate), ['start']);
    writeFileSync(gate.release, 'released');
    const [submitResult, competitorResult] = await Promise.all([submitted.closed, competitor.closed]);
    assert.equal(submitResult.code, 0, submitted.stderrText);
    assert.match(submitted.stdoutText, /submitted #1/);
    assert.equal(competitorResult.code, 0, competitor.stderrText);
    assert.deepEqual(gateEvents(gate), ['start', 'end', 'start', 'end']);
  } finally {
    writeFileSync(gate.release, 'released');
    await Promise.all(children.map((child) => child.closed));
  }
});

test('pre-push keeps its machine gate slot until the hook check finishes [C3,Q4]', async () => {
  const box = sandbox();
  const gate = holdingGate(box);
  const projectBox = project(gate.command, box);
  const remote = join(box.dir, 'remote.git');
  projectBox.git(box.dir, 'init', '-q', '--bare', remote);
  projectBox.git(projectBox.repo, 'remote', 'add', 'origin', remote);
  assert.equal((await projectBox.runIn(projectBox.repo, 'settings', 'gateSlots', '1')).code, 0);
  writeFileSync(gate.mode, 'armed');
  const children = [];
  try {
    const pushed = launch(projectBox, projectBox.repo, 'git', ['push', '-q', 'origin', 'main']);
    children.push(pushed);
    await waitFor(() => gateEvents(gate).includes('start'), 'pre-push gate to start and hold its resource');
    const competitor = launch(projectBox, projectBox.web, process.execPath, [BIN, 'gate']);
    children.push(competitor);
    await waitFor(() => competitor.stdoutText.includes('place 1'), 'another gate to wait behind pre-push');
    assert.deepEqual(gateEvents(gate), ['start']);
    writeFileSync(gate.release, 'released');
    const [pushResult, competitorResult] = await Promise.all([pushed.closed, competitor.closed]);
    assert.equal(pushResult.code, 0, pushed.stderrText);
    assert.equal(competitorResult.code, 0, competitor.stderrText);
    assert.deepEqual(gateEvents(gate), ['start', 'end', 'start', 'end']);
  } finally {
    writeFileSync(gate.release, 'released');
    await Promise.all(children.map((child) => child.closed));
  }
});

test('explicit and trunk pre-push landings jump the machine gate line and show in resources [Q1,Q2]', async () => {
  const box = sandbox();
  const gate = holdingGate(box);
  const projectBox = project(gate.command, box);
  assert.equal((await projectBox.runIn(projectBox.repo, 'settings', 'gateSlots', '1')).code, 0);
  writeFileSync(gate.mode, 'armed');

  const ordinary = launch(projectBox, projectBox.repo, process.execPath, [BIN, 'gate']);
  const children = [ordinary];
  let explicitLanding;
  try {
    await waitFor(() => gateEvents(gate).length === 1, 'ordinary gate to hold the sole machine slot');
    explicitLanding = launch(projectBox, projectBox.web, process.execPath, [BIN, 'gate', '--landing']);
    children.push(explicitLanding);
    let latestResources = '';
    await waitFor(async () => {
      const result = await projectBox.runIn(projectBox.repo, 'resources', '--json');
      assert.equal(result.code, 0, result.err);
      latestResources = result.out;
      const resource = JSON.parse(result.out).resources.find((entry) => entry.scope === 'machine' && entry.name === 'gate');
      return resource?.line.length > 0;
    }, 'explicit gate run to appear in the resource listing').catch((error) => {
      throw new Error(`${error.message}\nresources: ${latestResources}\nlanding stdout: ${explicitLanding.stdoutText}\nlanding stderr: ${explicitLanding.stderrText}\nevents: ${gateEvents(gate).join(',')}`);
    });
    const json = await projectBox.runIn(projectBox.repo, 'resources', '--json');
    assert.equal(json.code, 0, json.err);
    const queued = JSON.parse(json.out).resources.find((resource) => resource.scope === 'machine' && resource.name === 'gate');
    assert.deepEqual(queued.line.map(({ landing }) => landing), [true]);
    const humanQueue = await projectBox.runIn(projectBox.repo, 'resources');
    assert.equal(humanQueue.code, 0, humanQueue.err);
    assert.match(humanQueue.out, /waiting: .* \(landing\)/u);
    writeFileSync(gate.release, 'released');
    const results = await Promise.all(children.map((child) => child.closed));
    assert.deepEqual(results.map(({ code }) => code), [0, 0]);
    assert.deepEqual(gateEvents(gate), ['start', 'end', 'start', 'end']);
  } finally {
    writeFileSync(gate.release, 'released');
    await Promise.all(children.map((child) => child.closed));
  }

  const pushBox = sandbox();
  const pushGate = holdingGate(pushBox);
  const pushProject = project(pushGate.command, pushBox);
  const remote = join(pushBox.dir, 'remote.git');
  pushProject.git(pushBox.dir, 'init', '-q', '--bare', remote);
  pushProject.git(pushProject.repo, 'remote', 'add', 'origin', remote);
  assert.equal((await pushProject.runIn(pushProject.repo, 'settings', 'gateSlots', '1')).code, 0);
  writeFileSync(pushGate.mode, 'armed');
  const holder = launch(pushProject, pushProject.web, process.execPath, [BIN, 'gate']);
  const pushChildren = [holder];
  let push;
  try {
    await waitFor(() => gateEvents(pushGate).length === 1, 'gate holder to start before trunk push');
    push = launch(pushProject, pushProject.repo, 'git', ['push', '-q', 'origin', 'main']);
    pushChildren.push(push);
    let latestPushResources = '';
    await waitFor(async () => {
      const result = await pushProject.runIn(pushProject.repo, 'resources', '--json');
      assert.equal(result.code, 0, result.err);
      latestPushResources = result.out;
      const resource = JSON.parse(result.out).resources.find((entry) => entry.scope === 'machine' && entry.name === 'gate');
      return resource?.line.length > 0;
    }, 'trunk pre-push gate to appear in the resource listing').catch((error) => {
      throw new Error(`${error.message}\nresources: ${latestPushResources}\npush stdout: ${push.stdoutText}\npush stderr: ${push.stderrText}\nevents: ${gateEvents(pushGate).join(',')}`);
    });
    const json = await pushProject.runIn(pushProject.repo, 'resources', '--json');
    assert.equal(json.code, 0, json.err);
    const queued = JSON.parse(json.out).resources.find((resource) => resource.scope === 'machine' && resource.name === 'gate');
    assert.deepEqual(queued.line.map(({ landing }) => landing), [true], 'the hook marks its trunk update as a landing');
    const humanQueue = await pushProject.runIn(pushProject.repo, 'resources');
    assert.equal(humanQueue.code, 0, humanQueue.err);
    assert.match(humanQueue.out, /waiting: .* \(landing\)/u);
    writeFileSync(pushGate.release, 'released');
    const results = await Promise.all(pushChildren.map((child) => child.closed));
    assert.deepEqual(results.map(({ code }) => code), [0, 0]);
    assert.deepEqual(gateEvents(pushGate), ['start', 'end', 'start', 'end']);
  } finally {
    writeFileSync(pushGate.release, 'released');
    await Promise.all(pushChildren.map((child) => child.closed));
  }
});
