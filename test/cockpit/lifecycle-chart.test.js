// pullboard: browser
/** @pullboard-test-gui */
/** The approved chart preserves move totals while keeping Activity a feed by default [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../src/board.js';
import { openBoard } from '../../apps/lib/index.js';
import { MACHINE } from '../../packages/state/index.js';
import { seedNativeOrdinary } from './lifecycle-ordinary-seed.js';
import { nativeRareJourneys, seedRareLifecycleJourneys } from './lifecycle-native-seed.js';
import { lifecycleEvent as lifecycleHistoryEvent } from '../../packages/items/index.js';
import { machine, project, build, sendBack, boardOf, pickProject, startView, openPage, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press, proofShot } from './fixture.js';

test('lifecycle history keeps a typed retained-claim correction without forwarding private event details [N26]', () => {
  const event = { event_kind: 'refreeze', event_by: 'web-1', event_at: '2026-10-28T12:00:00Z', event_detail: JSON.stringify({ retainedClaim: true, privateNote: 'not for the summary' }) };
  assert.deepEqual(lifecycleHistoryEvent(event), { kind: 'refreeze', by: 'web-1', at: event.event_at, retainedClaim: true });
  for (const detail of ['{}', '{"retainedClaim":false}', '{"retainedClaim":"true"}']) {
    assert.deepEqual(lifecycleHistoryEvent({ ...event, event_detail: detail }), { kind: 'refreeze', by: 'web-1', at: event.event_at });
  }
  assert.throws(() => lifecycleHistoryEvent({ ...event, event_detail: 'malformed' }), SyntaxError, 'native projection refuses malformed refreeze detail');
  assert.deepEqual(lifecycleHistoryEvent({ ...event, event_kind: 'submit' }), { kind: 'submit', by: 'web-1', at: event.event_at }, 'other event kinds never invent a retained claim');
});

test('browser replay and timeline retain Building through a corrected claim and count its later submit [N26]', async () => {
  const box = machine();
  project(box, 'lifecycle-retained');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const history = ['add', 'claim', 'refreeze', 'submit'].map((kind, index) => ({ kind, by: 'web-1', at: `2026-10-28T12:0${index}:00Z`, ...(kind === 'refreeze' ? { retainedClaim: true } : {}) }));
    const item = { status: 'submitted', history };
    const counts = JSON.parse(page.run(`JSON.stringify([...moveCounts([${JSON.stringify(item)}])])`));
    assert.deepEqual(counts, [['open>claimed:claim', 1], ['claimed>claimed:refreeze', 1], ['claimed>submitted:submit', 1]]);
    const thread = history.map((event, index) => ({ type: 'move', eventId: index + 1, kind: event.kind, by: event.by, at: event.at, ...(event.retainedClaim ? { detail: { retainedClaim: true } } : {}) }));
    const replayed = page.run(`timeline(${JSON.stringify({ ...item, thread })})`);
    assert.match(replayed, /claimed for 1m/u, 'a retained correction keeps the Building stay');
    assert.match(replayed, /submitted for/u, 'the following submit remains a real transition');
    assert.doesNotMatch(replayed, /lapse/u, 'the retained correction creates no invented idle return');
  } finally { await view.stop(); }
});

/** Verify exact visible labels against a board built through real native commands. */
test('Activity starts on its feed and remembers the plain lifecycle toggle in Chrome at desktop and phone widths [N26]', {
  timeout: 180_000, // budget: hang ceiling for seven native items, a real browser and two viewport/reload journeys.
}, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'real Chrome is required for the lifecycle chart');
  const box = machine();
  const demo = project(box, 'lifecycle-chart');
  const reviewer = JSON.parse(box.run(demo.repo, 'worktree', 'web', '--model', 'Lifecycle reviewer fixture', '--json')).path;
  for (let id = 1; id <= 7; id++) box.run(demo.repo, 'add', 'web', 'Lifecycle item ' + id, '--specs', 'G1', '--criterion', 'The page greets the visitor.');
  build(box, demo, 1, 'passed.txt');
  box.git(reviewer, 'switch', '-q', '--detach', demo.itemBranches.get(`${demo.baseBranch}:1`));
  box.run(reviewer, 'verify', '1', 'accept', '--no-next', '--note', 'The page greets the visitor.');
  build(box, demo, 2, 'back.txt');
  const rejected = JSON.parse(box.run(demo.repo, 'show', '2', '--json'));
  box.git(reviewer, 'switch', '-q', '--detach', rejected.item_commit);
  box.run(reviewer, 'verify', '2', 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', JSON.parse(rejected.item_frozen).criterion,
    '--note', 'The greeting is missing.', '--no-next');
  build(box, demo, 3, 'review.txt');
  box.run(demo.web, 'claim', '4');
  box.run(demo.web, 'release', '4', '--no-next', '--reason', 'OTHER', '--note', 'Another agent can take this.');
  box.run(demo.web, 'claim', '5');
  box.run(demo.web, 'claim', '5');
  box.run(demo.repo, 'withdraw', '6', 'This is outside the release.');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-lifecycle-chart-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!data?.project && !!document.querySelector("[data-tab=activity]")');
    await press(chrome, "document.querySelector('[data-tab=activity]')");
    await chrome.waitFor('!document.querySelector("[data-pane=activity]").hidden && !!document.querySelector("#activity .activity-events")');
    assert.equal(await chrome.stable('document.querySelector("#flow-panel").hidden'), true, 'no stored choice starts with the feed');
    assert.equal(await chrome.stable('document.querySelector("#flow svg") === null'), true, 'the hidden chart does not render');
    for (const width of [1440, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor('innerWidth === ' + width);
      const toggle = "document.querySelector('#flow-show')";
      assert.equal(await chrome.stable(toggle + '.textContent.trim()'), 'How work moves');
      await press(chrome, toggle);
      await chrome.waitFor('!document.querySelector("#flow-panel").hidden && !!document.querySelector("#flow svg")');
      assert.equal(await chrome.stable(toggle + '.getAttribute("aria-expanded")'), 'true');
      const actual = JSON.parse(await chrome.stable(`JSON.stringify({
        stages: [...document.querySelectorAll('[data-lifecycle-stage]')].map(node => [node.querySelector('.name').textContent, node.querySelector('.n').textContent, node.querySelector('.sub').textContent]),
        routes: [...document.querySelectorAll('[data-lifecycle-route]')].map(node => node.querySelector('.tag').textContent),
        tips: [...document.querySelectorAll('[data-lifecycle-route] title')].map(node => node.textContent),
        rareOpen: document.querySelector('.lifecycle-rare').open,
        withdrawnHeight: document.querySelector('#flow .box.withdrawn').getBBox().height,
        panelBeforeFeed: !!(document.querySelector('#flow-panel').compareDocumentPosition(document.querySelector('#activity')) & Node.DOCUMENT_POSITION_FOLLOWING),
        text: document.querySelector('.lifecycle-notes').textContent,
        toggleVisible: document.querySelector('#flow-show').getBoundingClientRect().width > 0,
        overflow: document.documentElement.scrollWidth > innerWidth
      })`));
      assert.deepEqual(actual.stages, [['Ready', '3', '1 of them sent back'], ['Building', '1', 'one agent each'], ['In review', '1', 'a different agent checks'], ['Verified', '1', 'passed review']], width + ': real board state counts');
      assert.deepEqual(actual.routes, ['5 taken', '3 submitted', '1 passed', '1 handed back', '1 sent back by a reviewer', '0 reopened after passing'], width + ': real board event counts');
      assert.ok(actual.tips.every(title => title.includes('moves.')), 'every route explains its count');
      assert.equal(actual.withdrawnHeight, 44, 'withdrawn SVG geometry stays independent of the sidebar');
      assert.equal(actual.rareOpen, false, 'rare routes are not drawn or disclosed by default');
      assert.equal(actual.panelBeforeFeed, true, 'chart opens in place above the feed');
      assert.equal(actual.toggleVisible, true);
      assert.equal(actual.overflow, false, width + ': chart does not widen the page');
      assert.match(actual.text, /1 claimed again while building/u);
      await press(chrome, "document.querySelector('.lifecycle-rare summary')");
      assert.equal(await chrome.stable('document.querySelector(".lifecycle-rare").open'), true, 'rare-route disclosure works');
      await proofShot(chrome, 'lifecycle-chart', width);
      await chrome.send('Page.reload');
      await chrome.waitFor('!!data?.project && !document.querySelector("#flow-panel").hidden && !!document.querySelector("#flow svg")');
      await press(chrome, toggle);
      assert.equal(await chrome.stable('document.querySelector("#flow-panel").hidden'), true, 'the same ghost button closes the chart');
      await chrome.send('Page.reload');
      await chrome.waitFor('!!data?.project && !!document.querySelector("#activity .activity-events")');
      assert.equal(await chrome.stable('document.querySelector("#flow-panel").hidden'), true, 'closed choice survives a reload');
    }
    assert.deepEqual(chrome.exceptions, [], 'chart and toggles produce no page exceptions');
  } finally {
    await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

/** Real source/reference journeys must survive native projection and the browser, not a hand-built count map. */
test('native rare lifecycle routes retain source receipts and render in Chrome at phone and desktop widths [N26]', {
  timeout: 300_000, // budget: real source ACCEPT, conflict/Submit, GET-only outside intake and two Chrome viewports.
}, async t => {
  const executable = chromeExecutable();
  assert.ok(executable, 'real Chrome is required for rare lifecycle routes');
  const box = machine();
  const demo = project(box, 'lifecycle-native-rare');
  // @pullboard-board-file journey: this private native board supplies the real receipts compared with its authenticated HTTP state and Chrome chart.
  const board = openBoard(join(demo.repo, '.git', 'pullboard', 'board.sqlite'));
  let view, chrome;
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-lifecycle-rare-chrome-'));
  try {
    const ordinary = seedNativeOrdinary(box, demo, { includeForward: true, keepClaim: false });
    view = await startView(box);
    /** Read the authenticated full native state, including the exact events used by its counts. */
    const readNativeProject = async () => {
      const state = await boardOf(view, demo.repo);
      assert.equal(state.root, demo.repo);
      assert.ok(state.moveCounts && typeof state.moveCounts === 'object', 'the native API supplies move counts');
      assert.ok(state.items.every(item => Array.isArray(item.thread) && Array.isArray(item.history)), 'detail=full retains native item threads and histories');
      return state;
    };
    const native = await seedRareLifecycleJourneys({ board, journeys: nativeRareJourneys(t, { box, demo, readProject: readNativeProject }),
      readProject: async () => {
        chrome = await openSnapshotChrome(executable, view.link.href, profile);
        await chrome.waitFor('!!data?.project');
        if (await chrome.stable('data.project.root') !== demo.repo) {
          await pickProject(chrome, 'document.querySelector(' + JSON.stringify('[data-root="' + demo.repo + '"]') + ')');
        }
        await chrome.waitFor('data?.project?.root === ' + JSON.stringify(demo.repo));
        return JSON.parse(await chrome.stable('JSON.stringify(data.project)'));
      } });
    assert.equal(Object.keys(native).length, 6, 'each rare/state family has its own real native receipt');
    const complete = await readNativeProject();
    for (const [route, count] of Object.entries(ordinary.expected)) {
      assert.equal(complete.moveCounts[route], count, 'the same native board retains its ordinary route: ' + route);
    }
    for (const verb of new Set(MACHINE.moves.map(move => move.verb))) {
      assert.ok(Object.entries(complete.moveCounts).some(([route, count]) => route.endsWith(':' + verb) && count > 0),
        'the same real native board exercises declared move ' + verb);
    }
    await press(chrome, "document.querySelector('[data-tab=activity]')");
    await chrome.waitFor('!document.querySelector("[data-pane=activity]").hidden');
    await press(chrome, "document.querySelector('#flow-show')");
    await chrome.waitFor('!!document.querySelector(".lifecycle-rare")');
    for (const width of [1440, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor('innerWidth === ' + width);
      assert.equal(await chrome.stable('document.querySelector(".lifecycle-rare").open'), false);
      assert.equal(await chrome.stable('document.querySelector(".lifecycle-rare summary").textContent'), '5 rare routes');
      await press(chrome, "document.querySelector('.lifecycle-rare summary')");
      const words = await chrome.stable('document.querySelector(".lifecycle-rare").textContent');
      for (const phrase of ['1 imported with an existing review', '1 submitted and passed together',
        '1 brought in for review', '1 updated after submission']) assert.ok(words.includes(phrase), width + ': ' + phrase);
      assert.ok(words.includes('1 updated after submission: In review to In review'));
      assert.ok(words.includes('1 updated after submission: Verified to In review'));
      const kept = await chrome.stable('document.querySelector(".lifecycle-notes").textContent');
      assert.ok(kept.includes('2 updated while building'), width + ': both claimed patch self loops are shown');
      for (const phrase of ['2 let go', '1 moved to a stronger agent', '1 check re-frozen', '1 went idle', '1 checks re-frozen while building']) {
        assert.ok(kept.includes(phrase), width + ': the same board renders ordinary return count ' + phrase);
      }
      assert.equal(await chrome.stable('document.documentElement.scrollWidth <= innerWidth'), true, width + ': no document overflow');
      await press(chrome, "document.querySelector('.lifecycle-rare summary')");
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    if (view) await view.stop();
    store.closeBoard(board);
    rmSync(profile, { recursive: true, force: true });
  }
});
