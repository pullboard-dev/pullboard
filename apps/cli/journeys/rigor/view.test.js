// pullboard: browser
/** @pullboard-test-gui */
/** The view shows sentinel drafts for the person to approve, with their proof [A6,D1,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SPEC,
  machine,
  project,
  build,
  sendBack,
  startView,
  openPage,
  boardOf,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
} from '../../tests/fixtures/cockpit/harness.js';

/**
 * A sentinel-draft call as sentinelDraftNeeds shapes it, citing one repeated cause and the commits that prove its check.
 *
 * @param {object} fields - The watch name, its check and whether it cites evidence.
 * @returns {object} One call in the state's shape.
 */
function draft({ name, check, cited = true }) {
  return {
    kind: 'sentinel-draft', id: `sentinel:${name}`, ref: name, check, directory: '.', every: 'hourly', owner: 'coordinator',
    text: `Sentinel draft: ${name} runs ${check} hourly, reporting to coordinator`,
    what: `pullboard sentinel approve ${name}, or decline it with --reason`, target: `sentinel:${name}`,
    ...(cited ? { cause: 'row:G1', evidence: { key: 'row:G1', items: [{ id: 4, commits: [] }, { id: 7, commits: [] }], occurrences: 2,
      proof: { check, red: { commit: 'aaaaaaaaaaaa1111', exit: 1 }, green: { commit: 'bbbbbbbbbbbb2222', exit: 0 } } } } : {}),
  };
}

test('the view state carries a pending sentinel draft [A6,D1,N26]', async () => {
  const box = machine();
  const p = project(box, 'sentinel board', SPEC);
  box.run(p.repo, 'sentinel', 'propose', 'staging-site', '--check', 'true', '--every', 'hourly', '--owner', 'web');
  const view = await startView(box);
  try {
    const state = await boardOf(view, p.repo);
    assert.deepEqual(state.sentinelDrafts.map((call) => call.ref), ['staging-site'], 'the state carries the pending watch as one call');
    assert.equal(state.sentinelDrafts[0].kind, 'sentinel-draft');
    assert.ok(state.needs.some((call) => call.kind === 'sentinel-draft'), 'and Needs-you counts it');
  } finally {
    await view.stop();
  }
});

test('clause 1: the view shows one sentinel draft with its proof, never as an approved sentinel [A6,D1,N26]', async () => {
  const box = machine();
  project(box, 'draft board', SPEC);
  const view = await startView(box);
  try {
    const page = await openPage(view);
    // Pages open on the Dashboard since #2289 and draw Needs you on Items only, so open Items as a person would.
    await page.click({ tab: 'items' });
    await page.run(`data.project.sentinelDrafts = ${JSON.stringify([draft({ name: 'rigor-row-g1', check: 'test -f up.txt' })])}; render();`);
    const html = page.show('needs');
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.equal((html.match(/data-sentinel-draft=/g) || []).length, 1, 'one draft is one row');
    assert.match(text, /rigor-row-g1 Run test -f up\.txt hourly, reporting to coordinator/, 'the row names the watch and its check');
    assert.match(text, /Sentinel draft · not watching until you approve/, 'it is labelled a draft awaiting approval');
    assert.match(text, /Proposed by An agent · 2 repeats Repeated cause row:G1 Cited items #4, #7/, 'it cites the repeat');
    assert.match(text, /Proof command test -f up\.txt Red proof aaaaaaaaaaaa · exit 1 Green proof bbbbbbbbbbbb · exit 0/, 'it shows the red and green proof');
    assert.doesNotMatch(text, /release|approved sentinel|is watching/i, 'it is neither a lane hold nor an approved sentinel');
    await page.run(`data.project.sentinelDrafts = ${JSON.stringify([draft({ name: 'x<b>y', check: 'true', cited: false })])}; render();`);
    const bare = page.show('needs');
    assert.match(bare, /Proposed by.*An agent, with no repeat cited/, 'a draft with no evidence says so');
    assert.ok(!bare.includes('<b>y'), 'the name is escaped');
    await page.run('data.project.sentinelDrafts = []; render();');
    assert.equal(page.show('needs').includes('data-sentinel-draft'), false, 'an approved or declined draft leaves Needs-you');
  } finally {
    await view.stop();
  }
});

test('a Rigor proposal reaches Needs you only after coordinator materialization [D1,A6,N26]', async () => {
  const box = machine();
  project(box, 'automatic proposal board', SPEC);
  const view = await startView(box);
  try {
    const page = await openPage(view);
    // Pages open on the Dashboard since #2289 and draw Needs you on Items only, so open Items as a person would.
    await page.click({ tab: 'items' });
    await page.run(`data.project.rigorDrafts = [{kind:'rigor-draft',id:'doctrine:RG1',ref:'doctrine:RG1',target:'doctrine:RG1',
      text:'Rigor draft (unproved): Review the repeated cause.',unproved:true,materialized:false,
      what:'Coordinator: materialize with pullboard spec apply; then the person approves or declines'}]; render();`);
    assert.doesNotMatch(page.show('needs'), /Rigor|materialize/u, 'coordinator preparation is not a person call');
    await page.run('data.project.rigorDrafts[0].materialized = true; render();');
    const html = page.show('needs');
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.match(text, /an unproved Rigor proposal/u);
    assert.match(text, /Rigor draft \(unproved\)/u);
    assert.doesNotMatch(text, /a proved Rigor draft|red commit|green commit/u);
    assert.ok(html.includes('data-go="doctrine:RG1"'), 'materialization makes the actual draft row actionable');
  } finally { await view.stop(); }
});

test('a materialized automatic Rigor draft shows in Needs you, marked unproved, with its evidence [D1,A6,N26]', async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the Needs you width checks.');
  const box = machine();
  const alpha = project(box, 'auto rigor', SPEC);
  for (const title of ['Greeting', 'Farewell']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  // Two sent-back items with the same cause: the board drafts the Rigor proposal itself, with no rigor command run.
  build(box, alpha, 1, 'greeting.html');
  sendBack(box, alpha, 1, 'no greeting on the page');
  build(box, alpha, 2, 'farewell.html');
  sendBack(box, alpha, 2, 'no farewell on the page');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-rigor-view-chrome-'));
  let chrome;
  try {
    const state = await boardOf(view, alpha.repo);
    const served = state.rigorDrafts.filter((call) => call.unproved);
    assert.ok(served.length > 0, 'serve.js carries the automatic draft');
    assert.ok(served.every((call) => call.proof == null && call.evidence.occurrences >= 2), 'with its repeat evidence and no proof');
    assert.ok(!state.needs.some((call) => call.kind === 'rigor-draft'), 'board-only proposals stay with the coordinator');
    const applied = JSON.parse(box.run(alpha.repo, 'spec', 'apply', '--json'));
    assert.equal(applied.version, 1, 'the successful CLI helper returns the public JSON document');
    assert.deepEqual(applied.applied, [], 'materializing an unproved proposal approves no person decision');
    const materialized = await boardOf(view, alpha.repo);
    assert.ok(materialized.needs.some((call) => call.kind === 'rigor-draft' && call.materialized), 'the real coordinator write exposes a person-actionable draft');
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project?.rigorDrafts?.length > 0");
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      await chrome.click(`document.querySelector('[data-tab=items]')`);
      const read = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const needs = document.querySelector('#needs');
        const rows = [...needs.querySelectorAll('.needs-call')].map((row) => ({ words: row.querySelector('.needs-copy b').textContent,
          kind: row.querySelector('.needs-copy small').textContent, chip: row.querySelector('.needs-action').textContent, go: row.querySelector('.actions [data-go]')?.dataset.go ?? null,
          right: row.getBoundingClientRect().right }));
        return { shown: !needs.hidden && needs.getBoundingClientRect().height > 0, rows,
          page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth } };
      })())`));
      const at = `${width}px`;
      assert.ok(read.shown, `${at}: Needs you is showing`);
      assert.ok(read.page.scroll <= read.page.width, `${at}: no sideways scroll`);
      const rigor = read.rows.filter((row) => /Rigor/u.test(row.kind));
      assert.ok(rigor.length > 0, `${at}: the automatic draft is a row: ${JSON.stringify(read.rows)}`);
      for (const row of rigor) {
        assert.match(row.kind, /an unproved Rigor proposal, repeated 2 times/u, `${at}: marked unproved, with its repeat count: ${row.kind}`);
        assert.match(row.words, /#1, #2/u, `${at}: it names the repeated items: ${row.words}`);
        assert.doesNotMatch(row.kind + row.words, /a proved Rigor draft|approved/iu, `${at}: never shown as approved or proved`);
        assert.match(row.go, /^(doctrine|spec):/u, `${at}: the person opens the materialized row`);
        assert.ok(row.right <= read.page.width, `${at}: the row stays inside the page`);
      }
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});
