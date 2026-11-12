// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap checks: row detail paint speed, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  generateStressBoard,
  removeStressBoard,
} from '../../../tests/fixtures/cockpit/perf/generate.mjs';
import {
  BIN,
  chromeExecutable,
  closeSnapshotChrome,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';
import { openRoadmapChrome } from '../../../tests/fixtures/cockpit/roadmap.js';

/** Every item-detail read the page makes answers 500 ms late; the page logs each path asked and each answered. */
const SLOW_DETAIL = `(() => {
  const fetched = window.fetch.bind(window);
  window.__asked = []; window.__answered = [];
  window.fetch = (url, options) => {
    const path = new URL(String(url), location.href).pathname;
    if (!/\\/items\\/\\d+$/u.test(path)) return fetched(url, options);
    window.__asked.push(path);
    return fetched(url, options).then((reply) => new Promise((done) => setTimeout(() => { window.__answered.push(path); done(reply); }, 500)));
  };
  /** Time one roadmap row's click to the frame it is drawn in, and read what that frame shows. */
  window.__armExpand = (key) => {
    window.__painted = new Promise((resolve) => addEventListener('click', () => {
      const started = performance.now();
      requestAnimationFrame(() => {
        const row = [...document.querySelectorAll('#roadmap .milestone-item')].find((each) => each.dataset.roadmapKey === key), why = row.parentElement.querySelector('.milestone-why');
        resolve({ ms: performance.now() - started, expanded: row.getAttribute('aria-expanded'), shown: !why.hidden, block: !!why.querySelector('.roadmap-detail'),
          title: row.querySelector('.t').textContent, state: row.querySelector('.dot').className, loading: !!why.querySelector('.roadmap-loading'),
          fields: [...why.querySelectorAll('dt')].map((dt) => dt.textContent) });
      });
    }, { capture: true, once: true }));
    return true;
  };
  window.__sawLoading = false;
  new MutationObserver(() => { if (document.querySelector('#roadmap .roadmap-loading')) window.__sawLoading = true; }).observe(document, { childList: true, subtree: true });
})()`;

/** Start a foreground view on a generated stress board and read its local link. */
async function startStressView(board) {
  const child = spawn(process.execPath, [BIN, 'view', '--no-open', '--port', '0'], { cwd: board.root, env: { ...board.env, PULLBOARD_VIEW_FOREGROUND: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((done) => child.once('close', done));
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 30_000; // budget: hang ceiling for the generated board's view to print its link.
  while (Date.now() < deadline) {
    const link = /Pullboard view: (http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/u.exec(output);
    if (link) return { link: new URL(link[1]), stop: async () => {
      // The view's graceful close took about 70 s on the 1,038-item board after Chrome had left; the board is a disposable
      // fixture removed right after, so a view that has not closed within 5 s is ended.
      const ended = setTimeout(() => child.kill('SIGKILL'), 5_000); // budget: grace for the view's own close before the disposable fixture's process is ended.
      child.kill('SIGTERM'); await closed; clearTimeout(ended);
    } };
    await new Promise((done) => setTimeout(done, 25));
  }
  child.kill('SIGKILL');
  throw new Error('the stress board view printed no link');
}

test('expanding a roadmap row paints its detail within 100 ms [N26]', { timeout: 180_000 }, async (t) => {
  const began = performance.now();
  /** Name actual stage boundaries without changing either the hang ceiling or paint assertions. */
  const stage = phase => console.log('roadmap-expand-stage ' + JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - began) }));
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required to time a roadmap expand.');
  // A board our size: 1,038 items with their events, shouts and releases.
  stage('seed-start');
  const board = generateStressBoard({ seed: 'roadmap-expand-1039', size: 1_038 });
  stage('seed-end');
  stage('view-start');
  const view = await startStressView(board), profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-expand-chrome-'));
  stage('view-ready');
  const row = (key) => `[...document.querySelectorAll('#roadmap .milestone-item')].find((each) => each.dataset.roadmapKey === ${JSON.stringify(key)})`;
  const why = (key) => `${row(key)}.parentElement.querySelector('.milestone-why')`;
  /** Click one row and return what the frame after the click painted. */
  async function expand(key) {
    await chrome.stable(`window.__armExpand(${JSON.stringify(key)})`);
    await chrome.click(row(key));
    return chrome.stable('window.__painted');
  }
  const reads = async () => JSON.parse(await chrome.stable('JSON.stringify({ asked: window.__asked, answered: window.__answered })'));
  let chrome;
  try {
    stage('chrome-start');
    chrome = await openRoadmapChrome(executable, 'about:blank', profile);
    stage('chrome-ready');
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: SLOW_DETAIL });
    await chrome.send('Page.navigate', { url: view.link.href });
    await chrome.waitFor('data?.project?.items?.length === 1038', 30_000); // budget: hang ceiling for the first read of a board our size.
    stage('state-ready');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("view.tab === 'roadmap' && document.querySelectorAll('#roadmap .milestone-item').length > 100", 30_000); // budget: hang ceiling for the first roadmap draw.
    stage('roadmap-ready');
    // A row below the fold, never fetched ahead: its detail can only come from the delayed request.
    const far = await chrome.stable(`[...document.querySelectorAll('#roadmap .milestone-item[aria-expanded=false]')].filter((each) => /^i:#\\d+$/u.test(each.dataset.roadmapKey)
      && !each.closest('[hidden]') && each.getBoundingClientRect().top > innerHeight * 2).at(-1)?.dataset.roadmapKey`);
    assert.ok(far, 'the roadmap has a row below the fold');
    const farPath = '/items/' + far.slice(3);
    assert.equal((await reads()).asked.filter((path) => path.endsWith(farPath)).length, 0, 'the row below the fold was not read ahead');
    stage('first-expand-start');
    const painted = await expand(far);
    stage('first-expand-ready');
    t.diagnostic(`click to paint ${Math.round(painted.ms)} ms on ${far}`);
    assert.equal(painted.expanded, 'true'); assert.equal(painted.shown, true, 'the row opens in the frame after the click');
    assert.equal(painted.loading, false, 'no loading state shows'); assert.equal(painted.block, true, 'the row paints its block at once');
    assert.ok(painted.title.trim() && /\bdot\b/u.test(painted.state), 'the row keeps its title and state');
    assert.ok(painted.fields.includes('Release'), `the fields the summary holds paint at once: ${painted.fields}`);
    assert.ok(!painted.fields.includes('Criterion'), 'the criterion is still on its way');
    assert.ok(painted.ms < 100, `click to paint is under 100 ms: ${Math.round(painted.ms)} ms`);
    // The delayed fields fill the same block in place, with no loading flash between.
    await chrome.waitFor(`${why(far)}.querySelector('.roadmap-criterion') && ${why(far)}.textContent.includes('History')`, 10_000); // budget: hang ceiling for the 500 ms delayed read.
    assert.equal(await chrome.stable('window.__sawLoading'), false, 'no loading state showed at any point');
    // A second expand is instant: its detail is kept, so it paints whole and reads nothing.
    const asked = (await reads()).asked.length;
    await chrome.click(row(far));
    stage('repeat-expand-start');
    const again = await expand(far);
    stage('repeat-expand-ready');
    assert.ok(again.fields.includes('Criterion') && again.ms < 100, `a second expand paints whole at once: ${JSON.stringify(again)}`);
    // A row scrolled onto the screen is read ahead, so its first expand paints whole.
    const near = await chrome.stable(`[...document.querySelectorAll('#roadmap .milestone-item[aria-expanded=false]')].find((each) => /^i:#\\d+$/u.test(each.dataset.roadmapKey)
      && !each.closest('[hidden]') && each.dataset.roadmapKey !== ${JSON.stringify(far)})?.dataset.roadmapKey`);
    assert.ok(near, 'the roadmap has another folded row');
    await chrome.stable(`${row(near)}.scrollIntoView({ block: 'center', behavior: 'instant' }); true`);
    // Read ahead and drawn into the folded row once the queue drains.
    await chrome.waitFor(`window.__answered.some((path) => path.endsWith(${JSON.stringify('/items/' + near.slice(3))})) && !!${why(near)}.querySelector('.roadmap-criterion')`, 20_000); // budget: hang ceiling for the read ahead queue.
    stage('ahead-expand-start');
    const ahead = await expand(near);
    stage('ahead-expand-ready');
    assert.ok(ahead.fields.includes('Criterion') && !ahead.loading && ahead.ms < 100, `a row read ahead paints whole at once: ${JSON.stringify(ahead)}`);
    assert.equal((await reads()).asked.filter((path) => path.endsWith(farPath)).length, 1, 'the far row was read once');
    // A background refresh that moves no item reads no detail again.
    await chrome.waitFor('window.__asked.length === window.__answered.length', 30_000); // budget: hang ceiling for the reads ahead to drain.
    const settledReads = (await reads()).asked;
    assert.ok(settledReads.length >= asked, 'reads are counted');
    const shouted = spawnSync(process.execPath, [BIN, 'shout', 'all', 'A refresh that moves no item'], { cwd: board.root, env: board.env, encoding: 'utf8' });
    assert.equal(shouted.status, 0, shouted.stderr);
    await chrome.waitFor("data.project.shouts.some((each) => each.shout_text === 'A refresh that moves no item')", 20_000); // budget: hang ceiling for the next board poll.
    await chrome.waitFor('window.__asked.length === window.__answered.length', 10_000); // budget: hang ceiling for any read the refresh started.
    assert.deepEqual((await reads()).asked.slice(settledReads.length), [], 'the refresh fetched no detail of an item that has not moved');
    assert.deepEqual(chrome.exceptions, [], 'the roadmap raises no uncaught page exception');
    stage('body-end');
  } finally {
    stage('cleanup-start');
    if (chrome) await closeSnapshotChrome(chrome);
    stage('chrome-closed');
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
    stage('view-stopped');
    removeStressBoard(board);
    stage('cleanup-end');
  }
});
