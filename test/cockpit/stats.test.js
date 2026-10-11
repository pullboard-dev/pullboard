/** Cockpit stats checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../src/board.js';
import { SPEC, machine, project, build, sendBack, startView, accept, boardOf, earlier, proofShot, chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';

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

/** Stage a fully measured cycle and every live queue through native writers on a private clock. */
function stageFlowBoard(box, alpha) {
  const base = Date.now() - 120 * 60_000;
  const commit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const tree = box.git(alpha.repo, 'rev-parse', 'HEAD^{tree}');
  const digest = 'a'.repeat(64);
  /** Apply one native move at a known minute offset in this fixture's private board. */
  const at = (minute, write) => earlier(alpha.repo, base + minute * 60_000, write);
  at(0, board => store.register(board, { lane: 'tests', path: join(box.dir, 'flow-reviewer') }));
  for (const n of [2, 3]) at(0, board => store.register(board, { lane: 'web', path: join(box.dir, 'flow-builder-' + n) }));
  at(0, board => store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Flow item 1', specIds: ['G1'], criterion: 'Known flow' }));
  /** Assign live queues to distinct private builders so every claim remains valid. */
  const builder = id => id === 5 ? 'web-2' : id === 3 ? 'web-3' : 'web-1';
  /** Claim one item with a private frozen criterion and a lease that outlasts the observation. */
  const claim = (id, minute) => at(minute, board => store.claim(board, id, { agentId: builder(id), lane: 'web', leaseMs: 24 * 60 * 60_000, head: commit, freeze: () => ({ text: '{}', digest }) }));
  /** Record the submitted fixture commit through the actual lifecycle writer. */
  const submit = (id, minute) => at(minute, board => store.submit(board, id, { agentId: builder(id), commit, tree }));
  /** Reserve and accept with the private verifier so the review interval is measured. */
  const review = (id, start, end) => {
    at(start, board => store.reserveReview(board, id, { agentId: 'tests-1', leaseMs: 24 * 60 * 60_000, policy: 'any' }));
    at(end, board => store.verify(board, id, { agentId: 'tests-1', decision: 'ACCEPT', note: 'Private timed fixture', head: commit, digest, policy: 'any' }));
  };
  claim(1, 10); submit(1, 30); review(1, 70, 80);
  at(90, board => store.merged(board, 1, { agentId: 'coordinator', commit }));
  for (const id of [2, 3, 4, 5]) at(100, board => store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Flow item ' + id, specIds: ['G1'], criterion: 'Known flow' }));
  claim(3, 110); claim(4, 110); claim(5, 110);
  submit(4, 115); submit(5, 115); review(5, 117, 119);
}

test('the stats card shows API flow and bottleneck at 375 and 1280 [N26]', { timeout: 90_000 }, async t => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the flow card criterion.');
  const box = machine();
  const alpha = project(box, 'flow-card');
  const empty = project(box, 'flow-empty');
  stageFlowBoard(box, alpha);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-flow-card-chrome-'));
  let chrome;
  try {
    const api = (await boardOf(view, alpha.repo)).proofStats.flow;
    assert.deepEqual(Object.values(api.stages).map(stage => stage.averageMinutes), [10, 21, 6, 10], 'known native moves give measured build20/5/5, wait40/2, review10/2 and merge10 minutes');
    assert.deepEqual(Object.values(api.queues).map(queue => queue.size), [1, 1, 1, 1]);
    assert.deepEqual(Object.values(api.queues).map(queue => queue.oldest.id), [2, 3, 4, 5]);
    assert.equal(api.bottleneck.stage, 'reviewWait');
    assert.equal(api.bottleneck.recommendation, 'review the oldest submission first (#4)');
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!data?.project?.proofStats');
    await chrome.evaluate('document.querySelector(' + JSON.stringify('[data-root="' + alpha.repo + '"]') + ').click()');
    await chrome.waitFor('data?.project?.root === ' + JSON.stringify(alpha.repo) + ' && !!document.querySelector("[data-stage=build]")');
    const backgrounds = {};
    for (const scheme of ['light', 'dark']) for (const width of [375, 1280]) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
      const actual = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const card=document.querySelector('#proof-stats');
        const statement=card.querySelector('.proof-stats-bottleneck');
        const nodes=selector => [...card.querySelectorAll(selector)].map(node => ({ key:node.dataset.stage ?? node.dataset.queue ?? node.dataset.oldest, value:node.dataset.value, text:node.textContent }));
        const rects=[...card.querySelectorAll('.proof-stats-flow, .proof-stats-flow b, .proof-stats-flow small, .proof-stats-bottleneck')].map(node => ({width:node.getBoundingClientRect().width, right:node.getBoundingClientRect().right, overflow:node.scrollWidth > node.clientWidth + 1}));
        return { api:data.project.proofStats.flow, stages:nodes('[data-stage]'), queues:nodes('[data-queue]'), oldest:nodes('[data-oldest]'),
          bottleneck:card.querySelector('[data-flow=bottleneck]')?.textContent, action:card.querySelector('[data-flow=recommendation]')?.textContent,
          statementCount:card.querySelectorAll('.proof-stats-bottleneck').length, statementTag:statement?.tagName,
          statementText:statement?.textContent, visibleStatement:statement?.innerText,
          oneStatement:statement?.contains(card.querySelector('[data-flow=bottleneck]')) && statement?.contains(card.querySelector('[data-flow=recommendation]')),
          inlineWords:[...statement.children].every(node => getComputedStyle(node).display === 'inline'),
          unclipped:statement.scrollHeight <= statement.clientHeight + 1,
          darkTheme:matchMedia('(prefers-color-scheme: dark)').matches, background:getComputedStyle(document.body).backgroundColor,
          viewport:document.documentElement.clientWidth, pageWidth:document.documentElement.scrollWidth, rects };
      })())`));
      /** Format only the expected API number, independently of the page renderer. */
      const minutes = value => value === null ? 'unmeasured' : Number(value.toFixed(2)) + ' min';
      assert.deepEqual(actual.stages, Object.entries(actual.api.stages).map(([key, stage]) => ({key, value:String(stage.averageMinutes ?? ''), text:minutes(stage.averageMinutes)})), width + ': every stage displays the API average');
      assert.deepEqual(actual.queues, Object.entries(actual.api.queues).map(([key, queue]) => ({key, value:String(queue.size), text:String(queue.size)})), width + ': every queue displays the API size');
      assert.deepEqual(actual.oldest, Object.entries(actual.api.queues).map(([key, queue]) => ({key, value:String(queue.oldest?.ageMinutes ?? ''), text:queue.oldest ? 'Oldest: #' + queue.oldest.id + ' · ' + minutes(queue.oldest.ageMinutes) : 'Oldest: none'})), width + ': oldest ages come from the same API observation');
      assert.equal(actual.bottleneck, actual.api.bottleneck.message);
      assert.equal(actual.action, actual.api.bottleneck.recommendation);
      assert.equal(actual.statementCount, 1, 'one element contains the complete API statement');
      assert.equal(actual.statementTag, 'P', 'the message and action form one paragraph');
      assert.equal(actual.oneStatement, true, 'the API bottleneck and action share that paragraph');
      const sentence = 'Bottleneck: ' + actual.api.bottleneck.message + ' · ' + actual.api.bottleneck.recommendation;
      assert.equal(actual.statementText, sentence, 'the paragraph contains both full API strings');
      assert.equal(actual.visibleStatement, sentence, 'the entire statement is visible together');
      assert.equal(actual.inlineWords, true, 'the statement is never split into separate blocks');
      assert.equal(actual.unclipped, true, 'wrapping never cuts the statement short');
      assert.equal(actual.darkTheme, scheme === 'dark', 'the browser observes the requested theme');
      backgrounds[scheme] = actual.background;
      assert.ok(actual.pageWidth <= actual.viewport + 1, width + ': no sideways page scroll');
      assert.ok(actual.rects.every(rect => rect.width > 0 && rect.right <= actual.viewport + 1 && !rect.overflow), width + ': flow values and statement stay inside the card');
      if (scheme === 'dark') await proofShot(chrome, 'stats-flow', width);
    }
    assert.notEqual(backgrounds.light, backgrounds.dark, 'both color themes were rendered');
    await chrome.evaluate('document.querySelector(' + JSON.stringify('[data-root="' + empty.repo + '"]') + ').click()');
    await chrome.waitFor('data?.project?.root === ' + JSON.stringify(empty.repo));
    const blank = JSON.parse(await chrome.evaluate(`JSON.stringify({ stages:[...document.querySelectorAll('[data-stage]')].map(node => node.textContent), oldest:[...document.querySelectorAll('[data-oldest]')].map(node => node.textContent), action:document.querySelector('[data-flow=recommendation]')?.textContent ?? null, message:document.querySelector('[data-flow=bottleneck]')?.textContent, api:data.project.proofStats.flow })`));
    assert.deepEqual(blank.stages, Array(4).fill('unmeasured'), 'missing measurements are not invented zeroes');
    assert.deepEqual(blank.oldest, Array(4).fill('Oldest: none'));
    assert.equal(blank.action, null, 'no action is invented without an API recommendation');
    assert.equal(blank.message, blank.api.bottleneck.message);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
