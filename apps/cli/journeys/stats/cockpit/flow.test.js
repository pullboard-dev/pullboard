// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit stats checks: flow [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine } from '../../../tests/fixtures/cockpit/harness.js';
import { project } from '../../../tests/fixtures/cockpit/harness.js';
import { build } from '../../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../../tests/fixtures/cockpit/harness.js';
import { boardOf } from '../../../tests/fixtures/cockpit/harness.js';
import { proofShot } from '../../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../../tests/fixtures/cockpit/harness.js';
import { pickProject } from '../../../tests/fixtures/cockpit/harness.js';
import { press } from '../../../tests/fixtures/cockpit/harness.js';
import { displayDuration } from './fixture.js';
import { stageFlowBoard } from './fixture.js';
import * as store from '../../../../../packages/store/index.js';

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

test('the stats card shows API flow and bottleneck at 375 and 1280 [N26]', { timeout: 90_000 }, async t => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the flow card criterion.');
  const box = machine();
  const alpha = project(box, 'flow-card');
  const empty = project(box, 'flow-empty');
  stageFlowBoard(box, alpha, store);
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
  stageFlowBoard(box, alpha, store);
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
        shown: oldest ? { value: oldest.dataset.value, text: oldest.textContent } : null, api: data.project.proofStats.flow.queues.open.oldest });
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
    // The Shouts feed draws only on its own tab, so open it for the day names below and count redraws from there.
    await press(chrome, "document.querySelector('[data-tab=shouts]')");
    await chrome.waitFor("!!document.querySelector('#feed .conversation-row')");
    await chrome.stable(`(() => {
      window.__redraws = 0;
      window.__kept = [...document.querySelectorAll('#tabs .tab, #feed .conversation-row')];
      window.__scroll = [scrollX, scrollY];
      return true;
    })()`);
    // Past midnight, an unchanged read still draws nothing, and the day the page named Today is renamed Yesterday in
    // place, the shouts gaining the rule above it they leave off for today: the page's clock moves a day on, alone.
    const days = `JSON.stringify({ headings: [...document.querySelectorAll('.feed .day')].map((node) => node.textContent),
      rules: [...document.querySelectorAll('#feed > .day-rule span')].map((node) => node.textContent),
      untopped: (() => { const first = document.querySelector('#feed .shout, #feed .conversation-row'); return Boolean(first) && !first.previousElementSibling?.classList.contains('day-rule'); })() })`;
    const today = JSON.parse(await chrome.stable(days));
    // Today's run of shouts carries no label at its top (dayRules in connect.js), so it is the run that midnight must label.
    assert.deepEqual([today.headings, today.rules, today.untopped], [[], [], true], `today's run of rows is unlabelled at the top of the feed: ${JSON.stringify(today)}`);
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
    // Back on Items, where the control was written, count again from a quiet page.
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("!!document.querySelector('[data-oldest=open]')");
    await chrome.stable(`(() => {
      window.__redraws = 0;
      window.__kept = [...document.querySelectorAll('#tabs .tab, #proof-stats-summary, #chain > li, [data-oldest]')];
      window.__scroll = [scrollX, scrollY];
      return true;
    })()`);
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
