/** Cockpit stats checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SPEC, machine, project, build, sendBack, startView, accept, boardOf, chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';

/** Add a real joined worktree to the shared test board.
 * @param {ReturnType<typeof machine>} box
 * @param {{ repo: string }} p
 * @param {string} name
 * @returns {string}
 */
function joinedAgent(box, p, name) {
  const web = join(box.dir, `${name}-web`);
  box.git(p.repo, 'worktree', 'add', '-q', web, '-b', `web/${name}`);
  box.run(web, 'join', 'web');
  return web;
}


test('[V2,N26] real Chrome shows matching proof stats at phone width and clears on a group [V2,N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the proof stats card criterion.');

  const box = machine();
  const alpha = project(box, 'stats-phone', SPEC, { project: 'Proof project' });
  project(box, 'stats-other', SPEC, { project: 'Proof project' });
  box.run(alpha.repo, 'add', 'web', 'Reworked item', '--specs', 'G1', '--criterion', 'survives rework');
  build(box, alpha, 1, 'reworked.txt');
  sendBack(box, alpha, 1, 'the first submission needs another pass');
  build(box, alpha, 1, 'reworked-again.txt');
  accept(box, alpha, 1);
  box.git(alpha.repo, 'merge', '--no-ff', '-m', 'chore: merge accepted fixture', alpha.branch);
  box.run(alpha.repo, 'merged', '1', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  box.run(alpha.repo, 'add', 'web', 'Second accepted merge', '--specs', 'G1', '--criterion', 'records the merge');
  build(box, alpha, 2, 'second-accepted-merge.txt');
  accept(box, alpha, 2);
  box.git(alpha.repo, 'merge', '--no-ff', '-m', 'chore: merge second accepted fixture', alpha.branch);
  box.run(alpha.repo, 'merged', '2', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  const expected = JSON.parse(box.run(alpha.repo, 'stats', '--json')).stats;
  assert.deepEqual([expected.submissions, expected.rejections, expected.rejectionShare, expected.merged, expected.mergedWithoutAccept], [3, 1, 1 / 3, 2, 0], 'known real rejection, rework and two accepted merges');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-proof-stats-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("!!data?.project?.proofStats && document.querySelector('#proof-stats [data-stat=\"submissions\"]')");
    await chrome.evaluate(`document.querySelector('[data-root=${JSON.stringify(alpha.repo)}]').click()`);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && !!document.querySelector('#proof-stats [data-stat="submissions"]')`);
    const keys = ['submissions', 'rejections', 'rejectionShare', 'merged', 'mergedWithoutAccept', 'agentCount', 'familyCount', 'firstEventAt', 'lastEventAt'];
    const expectedValues = Object.fromEntries(keys.map((key) => [key, key === 'rejectionShare' ? `${(expected[key] * 100).toFixed(1)}%` : String(expected[key] ?? '')]));
    for (const scheme of ['light', 'dark']) for (const width of [375, 1280]) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const actual = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const card = document.querySelector('#proof-stats'), rect = card.getBoundingClientRect();
        const grid = getComputedStyle(card.querySelector('.proof-stats-grid'));
        return { hidden:card.hidden || !!card.closest('[hidden]'), display:getComputedStyle(card).display,
          width:rect.width, height:rect.height, right:rect.right, viewport:document.documentElement.clientWidth,
          columns:grid.gridTemplateColumns.split(' ').length,
          values:Object.fromEntries(${JSON.stringify(keys)}.map(key => { const node=card.querySelector('[data-stat="' + key + '"]'); return [key, node?.getAttribute('data-value') ?? null]; })),
          text:Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, card.querySelector('[data-stat="' + key + '"]')?.textContent ?? null])) };
      })())`));
      assert.equal(actual.hidden, false, `${width}: selected board's stats card is visible`);
      assert.equal(actual.display, 'grid', `${width}: stats card uses its computed grid layout`);
      assert.ok(actual.width > 0 && actual.height > 0 && actual.right <= actual.viewport + 1, `${width}: card has visible bounds inside the viewport`);
      assert.equal(actual.columns, width < 480 ? 2 : 4, `${width}: compact stats grid adapts to the viewport`);
      assert.deepEqual(actual.values, expectedValues, `${width}: every visible value matches pullboard stats --json`);
      const expectedText = JSON.parse(await chrome.evaluate(`JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key => {
        const value = ${JSON.stringify(expected)}[key];
        const date = key === 'firstEventAt' || key === 'lastEventAt';
        return [key, date ? (value ? new Date(value).toLocaleDateString([], { year:'numeric', month:'short', day:'numeric' }) : 'none') : ${JSON.stringify(expectedValues)}[key]];
      })))`));
      assert.deepEqual(actual.text, expectedText, `${width}: visible text also matches the stats response`);
    }
    await chrome.evaluate(`document.querySelector('[data-root="group:Proof project"]').click()`);
    await chrome.waitFor("data?.group?.name === 'Proof project' && document.querySelector('#group-view:not([hidden])') && document.querySelector('#proof-stats').hidden");
    assert.equal(await chrome.evaluate("document.querySelector('#proof-stats').innerHTML"), '', 'a grouped view cannot retain a prior repo\'s stats');
    const { flow: currentFlow, ...currentTotals } = (await boardOf(view, alpha.repo)).proofStats;
    const { flow: expectedFlow, ...expectedTotals } = expected;
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
  box.run(alpha.web, 'join', 'web', '--family', 'solo');
  const crewOne = joinedAgent(box, alpha, 'stats-crew-one');
  const crewTwo = joinedAgent(box, alpha, 'stats-crew-two');
  const crewThree = joinedAgent(box, alpha, 'stats-crew-three');
  const untouched = joinedAgent(box, alpha, 'stats-untouched');
  box.run(crewOne, 'join', 'web', '--family', 'crew');
  for (let move = 0; move < 11; move += 1) {
    box.run(crewOne, 'join', 'web', '--family', 'other');
    box.run(crewOne, 'join', 'web', '--family', 'crew');
  }
  box.run(crewTwo, 'join', 'web', '--family', 'crew');
  box.run(crewThree, 'join', 'web', '--family', 'crew');
  const expected = JSON.parse(box.run(alpha.repo, 'stats', '--json')).stats;
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
    await chrome.waitFor("!!data?.project?.proofStats && document.querySelector('#proof-stats .proof-stats-detail')");
    await chrome.evaluate(`document.querySelector('[data-root=${JSON.stringify(alpha.repo)}]').click()`);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && !!document.querySelector('#proof-stats .proof-stats-detail')`);
    const detail = await chrome.evaluate("document.querySelector('#proof-stats .proof-stats-detail').textContent");
    assert.match(detail, /solo \(1 agent, 1 move\)/);
    assert.match(detail, /crew \(3 agents, 14 moves\)/);
    assert.match(detail, /web-5 \(unknown; 1 move\)/);
    assert.match(detail, /web-2 \(crew\/other\/unknown; 24 moves\)/);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
