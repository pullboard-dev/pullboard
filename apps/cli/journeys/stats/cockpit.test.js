// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit stats checks, using the shared real-board fixtures [N26]. */
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { MACHINE_MODEL } from '../../tests/fixtures/cockpit/machine.js';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  tapTarget,
  SPEC,
  machine,
  project,
  build,
  sendBack,
  startView,
  accept,
  boardOf,
  earlier,
  proofShot,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  pickProject,
  press,
  tapTouch,
} from '../../tests/fixtures/cockpit/harness.js';

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

/** Express one API duration at its rounded, human-readable unit for visible-label assertions. */
function displayDuration(value) {
  if (value === null || value === undefined) return 'unmeasured';
  const rounded = Math.round(value);
  if (rounded < 60) return rounded + ' min';
  const hours = Math.floor(rounded / 60);
  return hours < 24 ? hours + ' h ' + rounded % 60 + ' min' : Math.floor(hours / 24) + ' d ' + hours % 24 + ' h';
}

/** Read the rendered stats toggle state and its focus target without deriving application behavior. */
async function statsToggleState(chrome) {
  return JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const summary = document.querySelector('#proof-stats-summary');
    const full = document.querySelector('#proof-stats-full');
    return { expanded:summary?.getAttribute('aria-expanded') ?? null, sign:summary?.querySelector('.proof-stats-caret')?.textContent ?? null,
      hidden:full?.hidden ?? true, closeCount:document.querySelectorAll('#proof-stats-close, [data-stats-close]').length,
      focus:document.activeElement?.id ?? null, height:summary?.getBoundingClientRect().height ?? 0,
      tap:getComputedStyle(document.documentElement).getPropertyValue('--tap').trim() };
  })())`));
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
    await chrome.waitFor("!!data?.project");
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("!!data?.project?.proofStats && document.querySelector('#proof-stats [data-stat=\"submissions\"]')");
    await pickProject(chrome, `document.querySelector('[data-root=${JSON.stringify(alpha.repo)}]')`);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && !!document.querySelector('#proof-stats [data-stat="submissions"]')`);
    await press(chrome, "document.querySelector('#proof-stats-summary')");
    await chrome.waitFor("!document.querySelector('#proof-stats-full').hidden");
    const keys = ['submissions', 'rejections', 'rejectionShare', 'merged', 'mergedWithoutAccept', 'agentCount', 'firstEventAt', 'lastEventAt'];
    const expectedValues = Object.fromEntries(keys.map((key) => [key, key === 'rejectionShare' ? `${(expected[key] * 100).toFixed(1)}%` : String(expected[key] ?? '')]));
    for (const scheme of ['light', 'dark']) for (const width of [375, 1280]) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const actual = JSON.parse(await chrome.stable(`JSON.stringify((() => {
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
      const expectedText = JSON.parse(await chrome.stable(`JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key => {
        const value = ${JSON.stringify(expected)}[key];
        const date = key === 'firstEventAt' || key === 'lastEventAt';
        return [key, date ? (value ? new Date(value).toLocaleDateString([], { year:'numeric', month:'short', day:'numeric' }) : 'none') : ${JSON.stringify(expectedValues)}[key]];
      })))`));
      assert.deepEqual(actual.text, expectedText, `${width}: visible text also matches the stats response`);
    }
    await pickProject(chrome, `document.querySelector('[data-root="group:Proof project"]')`);
    await chrome.waitFor("data?.group?.name === 'Proof project' && document.querySelector('#group-view:not([hidden])') && document.querySelector('#proof-stats').hidden");
    assert.equal(await chrome.stable("document.querySelector('#proof-stats').innerHTML"), '', 'a grouped view cannot retain a prior repo\'s stats');
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
  box.run(alpha.web, 'join', 'web', '--model', MACHINE_MODEL, '--family', 'solo');
  const crewOne = joinedAgent(box, alpha, 'stats-crew-one');
  const crewTwo = joinedAgent(box, alpha, 'stats-crew-two');
  const crewThree = joinedAgent(box, alpha, 'stats-crew-three');
  const untouched = joinedAgent(box, alpha, 'stats-untouched');
  // Record real moves on both sides of the one permitted family declaration.
  for (let move = 0; move < 11; move += 1) box.run(crewOne, 'shout', 'web-1', `Before family ${move}`);
  box.run(crewOne, 'join', 'web', '--family', 'crew');
  for (let move = 0; move < 11; move += 1) box.run(crewOne, 'shout', 'web-1', `After family ${move}`);
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
    await chrome.waitFor("!!data?.project");
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("!!data?.project?.proofStats && document.querySelector('#proof-stats-summary')");
    await pickProject(chrome, `document.querySelector('[data-root=${JSON.stringify(alpha.repo)}]')`);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && !!document.querySelector('#proof-stats-summary')`);
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("view.tab === 'items'");
    await press(chrome, "document.querySelector('#proof-stats-summary')");
    const detail = await chrome.stable("document.querySelector('#proof-stats-full').textContent");
    const count = await chrome.stable("document.querySelector('[data-stat=agentCount]').textContent");
    assert.equal(count, String(expected.agentCount), 'the expanded card keeps the API agent count');
    assert.doesNotMatch(detail, /solo|crew|web-\d+|Families/i, 'the card does not enumerate agent or family names');
    assert.equal(await chrome.stable("document.querySelector('[data-stat=familyCount]') === null"), true, 'the full card has no Families tile');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

/** Save an optional visual receipt for one collapsed or expanded stats-card layout. */
async function saveStatsToggleShot(chrome, width, scheme, state) {
  const directory = process.env.PULLBOARD_STATS_TOGGLE_PROOF;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  const shot = await chrome.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(directory, `stats-toggle-${width}-${scheme}-${state}.png`), Buffer.from(shot.data, 'base64'));
}

/** Exercise every real input path that opens and folds the proof card, then check its responsive targets. */
test('the stats card folds from its summary line [N26]', {
  timeout: 30_000, // budget: stop a hung local Chrome flow, not a rendering-speed assertion.
}, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the stats summary toggle criterion.');

  const box = machine();
  const alpha = project(box, 'stats-summary-toggle');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-stats-summary-toggle-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("!!data?.project");
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("!!data?.project?.proofStats && document.querySelector('#proof-stats-summary')");
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("view.tab === 'items'");
    await chrome.stable(`(() => {
      window.__statsTouchTargets = [];
      document.addEventListener('pointerdown', event => {
        if (event.pointerType === 'touch') window.__statsTouchTargets.push(event.target.closest('#proof-stats-summary') !== null);
      }, true);
      return true;
    })()`);

    for (const scheme of ['light', 'dark']) for (const width of [375, 1280]) {
      await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
      const start = await statsToggleState(chrome);
      assert.equal(start.expanded, 'false', `${width}px ${scheme}: summary starts collapsed`);
      assert.equal(start.sign, '+', `${width}px ${scheme}: plus signals that the card will open`);
      assert.equal(start.hidden, true, `${width}px ${scheme}: full card starts hidden`);
      assert.equal(start.closeCount, 0, `${width}px ${scheme}: no Close button is rendered`);
      assert.ok(start.height >= tapTarget(width), `${width}px ${scheme}: the summary meets the #371 target: ${JSON.stringify(start)}`);
      await saveStatsToggleShot(chrome, width, scheme, 'collapsed');

      await press(chrome, "document.querySelector('#proof-stats-summary')");
      let state = await statsToggleState(chrome);
      assert.equal(state.expanded, 'true', `${width}px ${scheme}: mouse click anywhere on the summary opens the card`);
      assert.equal(state.sign, '−', `${width}px ${scheme}: minus signals that the card will fold`);
      assert.equal(state.hidden, false, `${width}px ${scheme}: full card opens from the summary`);
      assert.equal(state.focus, 'proof-stats-summary', `${width}px ${scheme}: opening keeps focus on the toggle`);
      assert.equal(state.closeCount, 0, `${width}px ${scheme}: opening adds no Close button`);
      await saveStatsToggleShot(chrome, width, scheme, 'expanded');

      await press(chrome, "document.querySelector('#proof-stats-summary .proof-stats-caret')");
      state = await statsToggleState(chrome);
      assert.equal(state.expanded, 'false', `${width}px ${scheme}: clicking the minus folds the card`);
      assert.equal(state.sign, '+', `${width}px ${scheme}: folded card shows plus`);
      assert.equal(state.hidden, true, `${width}px ${scheme}: minus click hides the full card`);

      await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await chrome.waitFor("matchMedia('(pointer: coarse)').matches");
      state = await statsToggleState(chrome);
      assert.ok(state.height >= 44, `${width}px ${scheme}: touch mode keeps a 44px summary target: ${JSON.stringify(state)}`);
      await tapTouch(chrome, "document.querySelector('#proof-stats-summary')");
      state = await statsToggleState(chrome);
      assert.equal(state.expanded, 'true', `${width}px ${scheme}: a real touch opens the card`);
      assert.equal(state.focus, 'proof-stats-summary', `${width}px ${scheme}: touch keeps focus on the summary`);
      await tapTouch(chrome, "document.querySelector('#proof-stats-summary')");
      state = await statsToggleState(chrome);
      assert.equal(state.expanded, 'false', `${width}px ${scheme}: a second real touch folds the card`);
      const touchTargets = JSON.parse(await chrome.stable('JSON.stringify(window.__statsTouchTargets)'));
      assert.ok(touchTargets.length >= 2 && touchTargets.slice(-2).every(Boolean), `${width}px ${scheme}: real touch pointer events land on the summary: ${JSON.stringify(touchTargets)}`);

      await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await chrome.stable("document.querySelector('#proof-stats-summary').focus()");
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) });
      await chrome.waitFor("document.querySelector('#proof-stats-summary')?.getAttribute('aria-expanded') === 'true'");
      state = await statsToggleState(chrome);
      assert.equal(state.hidden, false, `${width}px ${scheme}: Enter opens the focused summary`);
      assert.equal(state.focus, 'proof-stats-summary', `${width}px ${scheme}: Enter retains focus on the summary`);
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, ...(type === 'keyDown' ? { text: ' ', unmodifiedText: ' ' } : {}) });
      await chrome.waitFor("document.querySelector('#proof-stats-summary')?.getAttribute('aria-expanded') === 'false'");
      state = await statsToggleState(chrome);
      assert.equal(state.hidden, true, `${width}px ${scheme}: Space folds the focused summary`);
      assert.equal(state.focus, 'proof-stats-summary', `${width}px ${scheme}: Space retains focus on the summary`);
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) });
      await chrome.waitFor("document.querySelector('#proof-stats-summary')?.getAttribute('aria-expanded') === 'true'");
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await chrome.waitFor("document.querySelector('#proof-stats-full').hidden");
      state = await statsToggleState(chrome);
      assert.equal(state.expanded, 'false', `${width}px ${scheme}: Escape folds the card`);
      assert.equal(state.sign, '+', `${width}px ${scheme}: Escape returns the plus sign`);
      assert.equal(state.focus, 'proof-stats-summary', `${width}px ${scheme}: Escape returns focus to the summary`);
      assert.equal(state.closeCount, 0, `${width}px ${scheme}: the full card still has no Close button`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

/** Exercise the glance layout with 300 real registrations and measured native lifecycle moves. */
// budget: 300 registrations plus four Chrome layouts; derived from the existing 90s browser ceiling with fixture headroom.
test('stats read at a glance on a board with hundreds of agents [N26,V2]', { timeout: 300_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the 300-agent stats layout criterion.');
  const box = machine();
  const alpha = project(box, 'stats-at-a-glance');
  stageFlowBoard(box, alpha);
  stageAcceptedQueue(box, alpha);
  const board = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    for (let index = 4; index <= 299; index += 1) {
      store.register(board, {
        lane: 'web',
        path: join(box.dir, `private-agent-${index}`),
        family: `private-family-${index % 7}`,
        model: `Private model ${index}`,
      });
    }
  } finally {
    store.closeBoard(board);
  }
  const stats = JSON.parse(box.run(alpha.repo, 'stats', '--json')).stats;
  assert.equal(stats.agentCount, 300, 'the actual board stats count all registered agents');

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-stats-at-a-glance-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("!!data?.project");
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("!!data?.project?.proofStats && document.querySelector('#proof-stats-summary') && document.querySelector('#chain > li')");
    const api = JSON.parse(await chrome.stable('JSON.stringify(data.project.proofStats)'));
    assert.equal(api.flow.bottleneck.stage, 'mergeWait', 'the real measured board has an accepted queue bottleneck');
    const expectedSummary = `${api.merged} merged · ${(Number(api.rejectionShare) * 100).toFixed(1)}% sent back`
      + (api.flow?.bottleneck ? ` · Bottleneck: Merge wait${api.flow.bottleneck.recommendation ? ', ' + api.flow.bottleneck.recommendation : ''}` : '');
    const layouts = [];
    for (const scheme of ['light', 'dark']) for (const width of [375, 1280]) {
      const height = width < 900 ? 812 : 800;
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`innerWidth === ${width} && innerHeight === ${height} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
      const before = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const summary=document.querySelector('#proof-stats-summary'), text=summary.querySelector('.proof-stats-summary-text');
        const rect=node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,width:r.width,right:r.right};};
        const lineHeight=parseFloat(getComputedStyle(text).lineHeight);
        const natural=text.cloneNode(true);
        Object.assign(natural.style,{position:'absolute',visibility:'hidden',width:text.getBoundingClientRect().width+'px',webkitLineClamp:'unset'});
        text.parentNode.append(natural);
        const naturalHeight=natural.getBoundingClientRect().height; natural.remove();
        const first=document.querySelector('#chain > li');
        return {summary:text.textContent, summaryLines:Math.ceil(text.getBoundingClientRect().height/lineHeight), summaryClipped:text.scrollHeight > text.clientHeight + 1, naturalHeight, lineHeight, clamp:getComputedStyle(text).webkitLineClamp, summaryBox:rect(summary),
          expanded:summary.getAttribute('aria-expanded'), first:first?.dataset.item ?? null, firstBox:first&&rect(first), itemListHidden:document.querySelector('#item-list').hidden,
          viewportWidth:document.documentElement.clientWidth, pageWidth:document.documentElement.scrollWidth, viewportHeight:innerHeight,
          itemOrder:data.project.items.filter(item => [3,4].includes(item.id)).map(item => ({id:item.id,status:item.status,updatedAt:item.updatedAt,holder:item.holder}))};
      })())`));
      assert.equal(before.summary, expectedSummary, `${width}px ${scheme}: the line selects the API merged, sent-back and bottleneck values`);
      assert.equal(before.expanded, 'false', `${width}px ${scheme}: the compact summary starts closed`);
      assert.equal(before.summaryLines <= (width < 900 ? 2 : 1), true, `${width}px ${scheme}: the summary occupies at most two compact lines: ${JSON.stringify(before.summaryBox)}`);
      assert.equal(before.clamp, width < 900 ? '2' : '1', `${width}px ${scheme}: overflow uses the browser's line-clamp ellipsis`);
      if (before.naturalHeight > before.lineHeight * (width < 900 ? 2 : 1) + 1) assert.equal(before.summaryClipped, true, `${width}px ${scheme}: a recommendation that would exceed the line limit is clipped`);
      assert.ok(before.summaryBox.height >= tapTarget(width), `${width}px ${scheme}: the summary meets the #371 target size`);
      assert.equal(before.itemListHidden, false, `${width}px ${scheme}: the item list remains the visible default`);
      assert.equal(before.first, '4', `${width}px ${scheme}: the first real item row is present: ${JSON.stringify(before.itemOrder)}`);
      assert.ok(before.firstBox.bottom <= height, `${width}px ${scheme}: the first item appears without scrolling: ${JSON.stringify(before)}`);
      assert.ok(before.pageWidth <= before.viewportWidth, `${width}px ${scheme}: no horizontal page overflow`);
      layouts.push({ scheme, width, firstBottom: before.firstBox.bottom, summaryHeight: before.summaryBox.height });

      if (process.env.PULLBOARD_STATS_PROOF) {
        mkdirSync(process.env.PULLBOARD_STATS_PROOF, { recursive: true });
        const shot = await chrome.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(process.env.PULLBOARD_STATS_PROOF, `stats-${width}-${scheme}.png`), Buffer.from(shot.data, 'base64'));
      }

      await press(chrome, "document.querySelector('#proof-stats-summary')");
      await chrome.waitFor("!document.querySelector('#proof-stats-full').hidden");
      const card = await chrome.stable("document.querySelector('#proof-stats-full').textContent");
      const details = JSON.parse(await chrome.stable(`JSON.stringify({agentCount:document.querySelector('[data-stat="agentCount"]')?.textContent,
        familyTile:!!document.querySelector('[data-stat="familyCount"]'), hasFirstAgent:document.querySelector('#proof-stats-full').textContent.includes('web-1'),
        hasPrivateName:document.querySelector('#proof-stats-full').textContent.includes('Private model'), hasFamilyName:document.querySelector('#proof-stats-full').textContent.includes('private-family-')})`));
      for (const agent of stats.agents) assert.equal(card.includes(agent.id), false, `${width}px ${scheme}: the card does not name ${agent.id}`);
      for (const family of api.families) assert.equal(card.includes(family.name), false, `${width}px ${scheme}: the card does not name family ${family.name}`);
      assert.equal(await chrome.stable("document.querySelector('[data-flow=bottleneck]').textContent"), api.flow.bottleneck.message, 'the full API message stays unchanged in the expanded card');
      assert.equal(await chrome.stable("document.querySelector('[data-flow=recommendation]').textContent"), api.flow.bottleneck.recommendation, 'the full API recommendation stays unchanged in the expanded card');
      assert.equal(details.agentCount, '300', `${width}px ${scheme}: the expanded card shows the count only`);
      assert.equal(details.familyTile, false, `${width}px ${scheme}: the expanded card has no Families tile`);
      assert.equal(details.hasFirstAgent || details.hasPrivateName || details.hasFamilyName, false, `${width}px ${scheme}: the card does not name agents or families`);
      assert.doesNotMatch(card, /Families:/i, `${width}px ${scheme}: no Families line appears in the card`);

      if (process.env.PULLBOARD_STATS_PROOF) {
        const shot = await chrome.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(process.env.PULLBOARD_STATS_PROOF, `stats-card-${width}-${scheme}.png`), Buffer.from(shot.data, 'base64'));
      }

      if (width === 375 && scheme === 'light') {
        await press(chrome, "document.querySelector('#proof-stats-summary')");
      } else {
        for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      }
      assert.equal(await chrome.stable("document.querySelector('#proof-stats-full').hidden"), true, `${width}px ${scheme}: the summary or Escape folds the expanded card`);
      assert.equal(await chrome.stable('document.activeElement?.id'), 'proof-stats-summary', `${width}px ${scheme}: closing returns focus to the list summary`);
      await chrome.stable('refresh().then(() => true)');
      assert.equal(await chrome.stable('document.activeElement?.id'), 'proof-stats-summary', `${width}px ${scheme}: a real API refresh preserves the returned keyboard focus`);
      assert.equal(await chrome.stable('document.querySelector("#chain > li")?.dataset.item'), '4', `${width}px ${scheme}: closing returns to the unchanged item list`);
    }
    assert.equal(layouts.length, 4, 'the compact board was checked in both themes at both target widths');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

/** Call the actual page formatter with fixed numeric inputs; the flow-card story checks its real API binding. */
// budget: derived from the existing 90s real-browser fixture ceiling; the six formatter calls add no wait.
test('stats times read in human units [N26,V2]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the human-unit stats criterion.');
  const box = machine();
  project(box, 'stats-human-units');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-stats-human-units-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("!!data?.project");
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("!!data?.project?.proofStats?.flow && document.querySelector('#proof-stats-summary')");
    const actual = JSON.parse(await chrome.stable('JSON.stringify([42,213.9,5707.5,null,59.6,1439.6].map(flowMinutes))'));
    assert.deepEqual(actual, ['42 min', '3 h 34 min', '3 d 23 h', 'unmeasured', '1 h 0 min', '1 d 0 h'], 'the actual production formatter rounds fixed inputs, including unit boundaries, without altering the API');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

/** Leave twenty real accepted items waiting long enough to exercise a long API recommendation. */
function stageAcceptedQueue(box, alpha) {
  const base = Date.now() - 120 * 60_000;
  const commit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const tree = box.git(alpha.repo, 'rev-parse', 'HEAD^{tree}');
  const digest = 'a'.repeat(64);
  for (let id = 6; id <= 26; id += 1) {
    earlier(alpha.repo, base, board => store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Waiting accepted item ' + id, specIds: ['G1'], criterion: 'Known accepted queue' }));
    earlier(alpha.repo, base + 60_000, board => store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 24 * 60 * 60_000, head: commit, freeze: () => ({ text: '{}', digest }) }));
    earlier(alpha.repo, base + 2 * 60_000, board => submitFixture(board, id, { agentId: 'web-1', commit, tree }));
    earlier(alpha.repo, base + 3 * 60_000, board => store.reserveReview(board, id, { agentId: 'tests-1', leaseMs: 24 * 60 * 60_000, policy: 'any' }));
    earlier(alpha.repo, base + 4 * 60_000, board => store.verify(board, id, { agentId: 'tests-1', decision: 'ACCEPT', note: 'Private accepted queue', head: commit, digest, policy: 'any' }));
    if (id === 26) earlier(alpha.repo, base + 104 * 60_000, board => store.merged(board, id, { agentId: 'coordinator', commit }));
  }
}

/** Stage a fully measured cycle and every live queue through native writers on a private clock. */
function stageFlowBoard(box, alpha) {
  const base = Date.now() - 120 * 60_000;
  const commit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const tree = box.git(alpha.repo, 'rev-parse', 'HEAD^{tree}');
  const digest = 'a'.repeat(64);
  /** Apply one native move at a known minute offset in this fixture's private board. */
  const at = (minute, write) => earlier(alpha.repo, base + minute * 60_000, write);
  for (const n of [2, 3]) box.git(alpha.repo, 'worktree', 'add', '-q', join(box.dir, 'flow-builder-' + n), '-b', 'web/flow-builder-' + n);
  at(0, board => store.register(board, { lane: 'tests', path: join(box.dir, 'flow-reviewer') }));
  for (const n of [2, 3]) at(0, board => store.register(board, { lane: 'web', path: join(box.dir, 'flow-builder-' + n) }));
  at(0, board => store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Flow item 1', specIds: ['G1'], criterion: 'Known flow' }));
  /** Assign live queues to distinct private builders so every claim remains valid. */
  const builder = id => id === 5 ? 'web-2' : id === 3 ? 'web-3' : 'web-1';
  /** Claim one item with a private frozen criterion and a lease that outlasts the observation. */
  const claim = (id, minute) => at(minute, board => store.claim(board, id, { agentId: builder(id), lane: 'web', leaseMs: 24 * 60 * 60_000, head: commit, freeze: () => ({ text: '{}', digest }) }));
  /** Record the submitted fixture commit through the actual lifecycle writer. */
  const submit = (id, minute) => at(minute, board => submitFixture(board, id, { agentId: builder(id), commit, tree }));
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
  for (const n of [2, 3]) box.run(join(box.dir, 'flow-builder-' + n), 'heartbeat');
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
    await chrome.waitFor("!!data?.project");
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor('!!data?.project?.proofStats');
    await pickProject(chrome, 'document.querySelector(' + JSON.stringify('[data-root="' + alpha.repo + '"]') + ')');
    await chrome.waitFor('data?.project?.root === ' + JSON.stringify(alpha.repo) + ' && !!document.querySelector("[data-stage=build]")');
    await press(chrome, "document.querySelector('#proof-stats-summary')");
    await chrome.waitFor("!document.querySelector('#proof-stats-full').hidden");
    const backgrounds = {};
    for (const scheme of ['light', 'dark']) for (const width of [375, 1280]) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.stable('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
      const actual = JSON.parse(await chrome.stable(`JSON.stringify((() => {
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
      assert.deepEqual(actual.stages, Object.entries(actual.api.stages).map(([key, stage]) => ({key, value:String(stage.averageMinutes ?? ''), text:displayDuration(stage.averageMinutes)})), width + ': every stage displays the API average in human units');
      assert.deepEqual(actual.queues, Object.entries(actual.api.queues).map(([key, queue]) => ({key, value:String(queue.size), text:String(queue.size)})), width + ': every queue displays the API size');
      assert.deepEqual(actual.oldest, Object.entries(actual.api.queues).map(([key, queue]) => ({key, value:String(queue.oldest?.ageMinutes ?? ''), text:queue.oldest ? 'Oldest: #' + queue.oldest.id + ' · ' + displayDuration(queue.oldest.ageMinutes) : 'Oldest: none'})), width + ': oldest ages come from the same API observation');
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
      assert.ok(actual.rects.every(rect => rect.width > 0 && rect.right <= actual.viewport + 1 && !rect.overflow), width + ': flow values and statement stay inside the card: ' + JSON.stringify(actual.rects));
      if (scheme === 'dark') await proofShot(chrome, 'stats-flow', width);
    }
    assert.notEqual(backgrounds.light, backgrounds.dark, 'both color themes were rendered');
    await pickProject(chrome, 'document.querySelector(' + JSON.stringify('[data-root="' + empty.repo + '"]') + ')');
    await chrome.waitFor('data?.project?.root === ' + JSON.stringify(empty.repo));
    const blank = JSON.parse(await chrome.stable(`JSON.stringify({ stages:[...document.querySelectorAll('#proof-stats [data-stage]')].map(node => node.textContent), oldest:[...document.querySelectorAll('#proof-stats [data-oldest]')].map(node => node.textContent), action:document.querySelector('#proof-stats [data-flow=recommendation]')?.textContent ?? null, message:document.querySelector('#proof-stats [data-flow=bottleneck]')?.textContent, api:data.project.proofStats.flow })`));
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

test('an unchanged board does not redraw on refresh [N26,N40]', {
  timeout: 90_000, // budget: hang ceiling for real board setup, Chrome and five real board reads.
}, async (t) => {
  // #644: every board read stamps the flow's observation clock (asOf) and each queue's oldest age afresh, so before
  // this a refresh of an unchanged board redrew the whole page and replaced every control under the pointer.
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the refresh redraw criterion.');
  const box = machine();
  const alpha = project(box, 'flow-refresh');
  stageFlowBoard(box, alpha);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-flow-refresh-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("!!data?.project");
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor('data?.project?.root === ' + JSON.stringify(alpha.repo) + ' && !!document.querySelector("[data-oldest=open]")');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await press(chrome, "document.querySelector('#proof-stats-summary')");
    await chrome.waitFor("!document.querySelector('#proof-stats-full').hidden");
    // Count every redraw from here on, and keep the nodes a person could be pointing at to see they survive.
    await chrome.stable(`(() => {
      const drawn = window.render;
      window.__redraws = 0;
      window.render = function (...args) { window.__redraws += 1; return drawn.apply(this, args); };
      window.__kept = [...document.querySelectorAll('#tabs .tab, #proof-stats-summary, #chain > li, [data-oldest]')];
      window.__scroll = [scrollX, scrollY];
      return true;
    })()`);
    /** Read the board as the page's live catch-up does, then report what the read changed on the page. */
    const reread = async () => JSON.parse(await chrome.stable(`(async () => {
      const before = data.project.proofStats.flow.asOf;
      await refresh();
      const oldest = document.querySelector('[data-oldest=open]');
      return JSON.stringify({ redraws: window.__redraws, newer: data.project.proofStats.flow.asOf > before,
        kept: window.__kept.every((node) => node.isConnected), scroll: [scrollX, scrollY], start: window.__scroll,
        shown: { value: oldest.dataset.value, text: oldest.textContent }, api: data.project.proofStats.flow.queues.open.oldest });
    })()`));
    for (let read = 1; read <= 3; read += 1) {
      await chrome.stable('new Promise((resolve) => setTimeout(() => resolve(true), 5))');
      const after = await reread();
      t.diagnostic(`unchanged read ${read}: ${JSON.stringify(after)}`);
      assert.equal(after.newer, true, `read ${read} is a fresh observation of the board: ${JSON.stringify(after)}`);
      assert.equal(after.redraws, 0, `read ${read} of an unchanged board does not redraw the page: ${JSON.stringify(after)}`);
      assert.equal(after.kept, true, `read ${read} keeps every element where it was: ${JSON.stringify(after)}`);
      assert.deepEqual(after.scroll, after.start, `read ${read} keeps the scroll position`);
      // What reads relative to now still follows the newest observation, without a redraw.
      assert.deepEqual(after.shown, { value: String(after.api.ageMinutes), text: 'Oldest: #' + after.api.id + ' · ' + displayDuration(after.api.ageMinutes) }, `read ${read}: the oldest age is the newest observation's`);
    }
    // Past midnight, an unchanged read still draws nothing, and the day the page named Today is renamed Yesterday in
    // place, the shouts gaining the rule above it they leave off for today: the page's clock moves a day on, alone.
    const days = `JSON.stringify({ headings: [...document.querySelectorAll('.feed .day')].map((node) => node.textContent),
      rules: [...document.querySelectorAll('#feed > .day-rule span')].map((node) => node.textContent),
      untopped: (() => { const first = document.querySelector('#feed .shout'); return Boolean(first) && !first.previousElementSibling?.classList.contains('day-rule'); })() })`;
    const today = JSON.parse(await chrome.stable(days));
    assert.ok(today.headings.includes('Today'), `the page names today's run of rows Today: ${JSON.stringify(today)}`);
    await chrome.stable(`(() => {
      const Real = Date;
      window.Date = class extends Real {
        constructor(...args) { super(...(args.length ? args : [Real.now() + 86_400_000])); }
        static now() { return Real.now() + 86_400_000; }
      };
      return true;
    })()`);
    const midnight = await reread();
    const renamed = JSON.parse(await chrome.stable(days));
    t.diagnostic(`read past midnight: ${JSON.stringify({ midnight, today, renamed })}`);
    assert.equal(midnight.redraws, 0, `a read past midnight of an unchanged board does not redraw the page: ${JSON.stringify(midnight)}`);
    assert.equal(midnight.kept, true, 'a read past midnight keeps every element where it was');
    assert.deepEqual(midnight.scroll, midnight.start, 'a read past midnight keeps the scroll position');
    assert.deepEqual(renamed.headings.map((name, index) => today.headings[index] === 'Today' ? name === 'Yesterday' : name !== 'Today'),
      today.headings.map(() => true), `the day the page called Today is called Yesterday now, in place: ${JSON.stringify({ today, renamed })}`);
    assert.ok(!renamed.rules.includes('Today'), 'no shout rule calls a day Today');
    assert.deepEqual(renamed.rules, today.untopped ? ['Yesterday', ...today.rules.map((name) => name === 'Yesterday' ? renamed.rules[1] : name)] : renamed.rules,
      'the shouts gain one rule, Yesterday, above what is no longer today');
    assert.equal(renamed.untopped, false, 'no shout run is left without its day');
    await chrome.stable('(() => { window.Date = Object.getPrototypeOf(window.Date); return true; })()');
    // A changed board still redraws, once: the page's own stream catch-up and a further read together draw it once.
    box.run(alpha.repo, 'shout', 'person', 'refresh redraw control');
    await chrome.waitFor("data.project.shouts.some((shout) => shout.shout_text === 'refresh redraw control')");
    const changed = await reread();
    t.diagnostic(`changed read: ${JSON.stringify(changed)}`);
    assert.equal(changed.redraws, 1, `a changed board redraws the page once: ${JSON.stringify(changed)}`);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
