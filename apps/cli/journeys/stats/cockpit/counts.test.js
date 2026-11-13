// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit stats checks: counts [N26]. */
import { MACHINE_MODEL } from '../../../tests/fixtures/cockpit/machine.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SPEC } from '../../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../../tests/fixtures/cockpit/harness.js';
import { project } from '../../../tests/fixtures/cockpit/harness.js';
import { build } from '../../../tests/fixtures/cockpit/harness.js';
import { sendBack } from '../../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../../tests/fixtures/cockpit/harness.js';
import { accept } from '../../../tests/fixtures/cockpit/harness.js';
import { boardOf } from '../../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../../tests/fixtures/cockpit/harness.js';
import { pickProject } from '../../../tests/fixtures/cockpit/harness.js';
import { press } from '../../../tests/fixtures/cockpit/harness.js';
import { joinedAgent } from './fixture.js';

test('[V2,N26] real Chrome page data carries matching proof stats and a group draws none [V2,N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the proof stats card criterion.');

  const box = machine();
  const alpha = project(box, 'stats-phone', SPEC, { project: 'Proof project' });
  project(box, 'stats-other', SPEC, { project: 'Proof project' });
  await box.inProcess(alpha.repo, 'add', 'web', 'Reworked item', '--specs', 'G1', '--criterion', 'survives rework');
  build(box, alpha, 1, 'reworked.txt');
  sendBack(box, alpha, 1, 'the first submission needs another pass');
  build(box, alpha, 1, 'reworked-again.txt');
  accept(box, alpha, 1);
  box.git(alpha.repo, 'merge', '--no-ff', '-m', 'chore: merge accepted fixture', alpha.branch);
  await box.inProcess(alpha.repo, 'merged', '1', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  await box.inProcess(alpha.repo, 'add', 'web', 'Second accepted merge', '--specs', 'G1', '--criterion', 'records the merge');
  build(box, alpha, 2, 'second-accepted-merge.txt');
  accept(box, alpha, 2);
  box.git(alpha.repo, 'merge', '--no-ff', '-m', 'chore: merge second accepted fixture', alpha.branch);
  await box.inProcess(alpha.repo, 'merged', '2', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  const expected = JSON.parse(await box.inProcess(alpha.repo, 'stats', '--json')).stats;
  assert.deepEqual([expected.submissions, expected.rejections, expected.rejectionShare, expected.merged, expected.mergedWithoutAccept], [3, 1, 1 / 3, 2, 0], 'known real rejection, rework and two accepted merges');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-proof-stats-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("!!data?.project");
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("!!data?.project?.proofStats");
    await pickProject(chrome, `document.querySelector('[data-root=${JSON.stringify(alpha.repo)}]')`);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && !!data?.project?.proofStats`);
    // The proof stats card left the Items tab on purpose (#6727); the counts still arrive in the page data.
    assert.equal(await chrome.stable("document.querySelector('#proof-stats') === null"), true, 'the Items tab no longer draws a proof stats card');
    const shown = JSON.parse(await chrome.stable('JSON.stringify(data.project.proofStats)'));
    for (const key of ['submissions', 'rejections', 'rejectionShare', 'merged', 'mergedWithoutAccept', 'agentCount', 'firstEventAt', 'lastEventAt']) {
      assert.deepEqual(shown[key], expected[key], `page data ${key} matches pullboard stats --json`);
    }
    await pickProject(chrome, `document.querySelector('[data-root="group:Proof project"]')`);
    await chrome.waitFor("data?.group?.name === 'Proof project' && document.querySelector('#group-view:not([hidden])')");
    assert.equal(await chrome.stable("document.querySelector('#proof-stats') === null"), true, 'a grouped view draws no stats card');
    const { flow: currentFlow, ...currentTotals } = (await boardOf(view, alpha.repo)).proofStats;
    const { flow: expectedFlow, agents, bars, caught, ...expectedTotals } = expected;
    for (const key of ['agents', 'bars', 'caught']) assert.equal(Object.hasOwn(currentTotals, key), false, `native state omits historical ${key}`);
    assert.ok(agents && bars && caught, 'the full CLI stats retain historical proof detail');
    assert.deepEqual(currentTotals, expectedTotals, 'the comparison reads the same live API stats source; queue ages may advance');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('[V2,N26] stats counts agree in number', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the stats count wording criterion.');

  const box = machine();
  const alpha = project(box, 'stats-count-words');
  await box.inProcess(alpha.web, 'join', 'web', '--model', MACHINE_MODEL, '--family', 'solo');
  const crewOne = joinedAgent(box, alpha, 'stats-crew-one');
  const crewTwo = joinedAgent(box, alpha, 'stats-crew-two');
  const crewThree = joinedAgent(box, alpha, 'stats-crew-three');
  const untouched = joinedAgent(box, alpha, 'stats-untouched');
  // Record real moves on both sides of the one permitted family declaration.
  const crewMove = text => box.inProcess(crewOne, 'shout', 'web-1', text);
  for (let move = 0; move < 11; move += 1) await crewMove(`Before family ${move}`);
  await box.inProcess(crewOne, 'join', 'web', '--family', 'crew');
  for (let move = 0; move < 11; move += 1) await crewMove(`After family ${move}`);
  await box.inProcess(crewTwo, 'join', 'web', '--family', 'crew');
  await box.inProcess(crewThree, 'join', 'web', '--family', 'crew');
  const expected = JSON.parse(await box.inProcess(alpha.repo, 'stats', '--json')).stats;
  assert.deepEqual(expected.families.find(({ name }) => name === 'solo'), { name: 'solo', agents: 1, moves: 1 });
  assert.deepEqual(expected.families.find(({ name }) => name === 'crew'), { name: 'crew', agents: 3, moves: 14 });
  assert.equal(expected.agents.find(({ id }) => id === 'web-5')?.moves, 1);
  assert.equal(expected.agents.find(({ id }) => id === 'web-2')?.moves, 24);
  assert.ok(untouched, 'the final worktree remains joined without a family change');

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-stats-number-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("!!data?.project");
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("!!data?.project?.proofStats");
    await pickProject(chrome, `document.querySelector('[data-root=${JSON.stringify(alpha.repo)}]')`);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && !!data?.project?.proofStats`);
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("view.tab === 'items'");
    const count = await chrome.stable('data.project.proofStats.agentCount');
    assert.equal(count, expected.agentCount, 'the page data keeps the API agent count');
    const page = await chrome.stable("document.querySelector('[data-pane=items]').textContent");
    assert.doesNotMatch(page, /solo|crew|Families/i, 'the Items tab does not enumerate agent or family names');
    assert.equal(await chrome.stable("document.querySelector('[data-stat=familyCount]') === null"), true, 'the Items tab has no Families tile');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
