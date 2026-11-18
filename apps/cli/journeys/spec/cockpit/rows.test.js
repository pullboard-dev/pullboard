// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit spec row layout checks, split from cockpit.test.js [N26,C7]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../../../../packages/config/index.js';
import {
  AGENT_SHELL_MARKERS,
  SSH_SHELL_MARKERS,
} from '../../../../../packages/kernel/index.js';
import {
  tapTarget,
  SPEC,
  machine,
  project,
  startView,
  styleOf,
  openPage,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
} from '../../../tests/fixtures/cockpit/harness.js';
import { pressTab } from '../../../tests/fixtures/cockpit/stable.js';

test('clause 1: spec rows read across a phone [N26,D1]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha', SPEC, { practice: 'DOCTRINE.md' });
  // Its own house rules follow the doctrine file named by this repo's config.
  writeFileSync(join(alpha.repo, loadConfig(alpha.repo).practice), '# Practice\n\n## W · Writing\n- W1 [approved, must] Numbers over adjectives. No hedges, no filler. | gate: review\n- W2 [draft, aim] One record per decision. | gate: review\n');
  const view = await startView(box);
  try {
    const page = await openPage(view, { width: 375 });
    await page.click({ tab: 'doctrine' });
    const doctrineRows = page.show('doctrine-list');
    assert.match(doctrineRows, /data-row="doctrine:W1"[^]*?Numbers over adjectives\./, 'W1 from the configured doctrine is shown');
    assert.match(doctrineRows, /data-row="doctrine:W2"[^]*?One record per decision\./, 'W2 from the configured doctrine is shown');
    const style = await styleOf(view);
    assert.match(style, /\.row \{ grid-template-areas: "dot t age" "dot meta chip";/, 'all three lists use the Items two-line grid');
    await page.click({ tab: 'spec' });
    await page.click({ rows: 'spec:all' });
    const rows = (html) => html.split('<div class="srow').slice(1);
    assert.deepEqual(rows(page.show('spec-list')).map((row) => /data-row="spec:([^"]+)"/.exec(row)[1]), ['G1', 'G2']);
    for (const kind of ['spec', 'doctrine']) {
      await page.click({ tab: kind });
      const drawn = rows(page.show(kind + '-list'));
      assert.ok(drawn.length > 0, kind + ' has rows');
      for (const row of drawn) {
        assert.match(row, /^ row s-[^"]*"[^]*?<span class="dot [^"]+"(?: aria-hidden="true")?>(?:[✓×✎]|<svg[^]*?<\/svg>)?<\/span><div><div class="t srow-text"><span class="row-id">[^<]+<\/span>/, kind + ' shares the dot and primary line');
        assert.match(row, /<div class="meta"><span class="(?:rule-source|rule-source-chip)/, kind + ' names its source on the secondary line');
      }
    }
  } finally {
    await view.stop();
  }
});

/** Show a declined Spec row's reason separately while preserving its text and escaping markup. */
test('a declined spec row shows its reason in the view [N26,S9]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to check Spec decision reasons.');

  const reason = 'Needs <script>alert("x")</script> & a clearer outcome';
  const spec = '# Decision reasons\n\n## G · Goals\n'
    + '- G1 [draft, must] Keep the original requirement text. | gate: review\n'
    + '- G2 [approved, must] This row was approved. | gate: review\n';
  const box = machine();
  const demo = project(box, 'declined-spec-reason', spec);
  const personEnv = { ...box.env };
  for (const name of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete personEnv[name];
  box.runWithEnv(demo.repo, personEnv, 'spec', 'decline', 'G1', '--reason', reason);
  box.runWithEnv(demo.repo, personEnv, 'spec', 'apply');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-reason-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor(`data?.project?.spec?.some(row => row.id === 'G1' && row.status === 'wont' && row.reason === ${JSON.stringify(reason)})`);
    await pressTab(chrome, 'spec');
    await chrome.click("document.querySelector('#spec-chips [data-rows=\"spec:all\"]')");
    await chrome.waitFor("!!document.querySelector('#spec-list [data-row=\"spec:G1\"]') && !!document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.click("document.querySelector('#spec-list [data-row=\"spec:G1\"]')");
    await chrome.waitFor("document.querySelector('#spec-detail h2 span')?.textContent === 'G1'");

    const declined = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const list = document.querySelector('#spec-list [data-row="spec:G1"]');
      const detail = document.querySelector('#spec-detail');
      const reasonNode = [...detail.querySelectorAll('dt')].find(entry => entry.textContent.trim() === 'reason')?.nextElementSibling;
      const listReason = list.querySelector('.rule-reason');
      return { id:list.querySelector('.row-id')?.textContent.trim(), text:list.querySelector('.srow-text').textContent.replace('G1', '').trim(),
        listReason:listReason?.textContent.trim() ?? null, listMarkup:listReason?.innerHTML ?? null,
        detailId:detail.querySelector('h2 span')?.textContent.trim(), detailText:detail.querySelector('h2')?.textContent.replace('G1', '').trim(),
        detailReason:reasonNode?.textContent.trim() ?? null, detailMarkup:reasonNode?.innerHTML ?? null,
        injectedScript:!!document.querySelector('#spec-list .rule-reason script,#spec-detail dd script') };
    })())`));
    assert.deepEqual([declined.id, declined.text], ['G1', 'Keep the original requirement text.'], 'the Spec list keeps the declined row text unchanged');
    assert.equal(declined.listReason, `Reason: ${reason}`, 'the Spec list shows the decline reason beside the row text');
    assert.ok(declined.listMarkup.includes('&lt;script&gt;'), 'the list escapes HTML-like reason text');
    assert.deepEqual([declined.detailId, declined.detailText, declined.detailReason], ['G1', 'Keep the original requirement text.', reason], 'the selected Spec detail shows the unchanged text and separate reason');
    assert.ok(declined.detailMarkup.includes('&lt;script&gt;'), 'the detail escapes HTML-like reason text');
    assert.equal(declined.injectedScript, false, 'reason text cannot inject an element into either view');

    await chrome.click("document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.waitFor("document.querySelector('#spec-detail h2 span')?.textContent === 'G2'");
    const approved = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const list = document.querySelector('#spec-list [data-row="spec:G2"]');
      const detail = document.querySelector('#spec-detail');
      return { listReason:list.querySelector('.rule-reason')?.textContent.trim() ?? null,
        detailReason:[...detail.querySelectorAll('dt')].some(entry => entry.textContent.trim() === 'reason') };
    })())`));
    assert.deepEqual(approved, { listReason:null, detailReason:false }, 'an approved row with no reason shows none in the list or detail');
    assert.deepEqual(chrome.exceptions, [], 'the real view raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive:true, force:true });
    await view.stop();
  }
});

test('Spec and Doctrine line up, open on a row and decide with filled and outlined controls [N26, B26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Spec layout checks.');

  const spec = '# Demo spec\n\n## G · Goals\n- G1 [draft, must] One short line. | gate: web test\n- G2 [draft, must] A second draft row. | gate: web test\n- G3 [approved, must] An approved row. | gate: web test\n';
  const box = machine();
  project(box, 'spec-layout', spec);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-layout-chrome-'));
  let chrome;
  /** Where the list and detail cards start, what is picked, and how a row's decision sits beside its text. */
  const read = async (kind) => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const pane = document.querySelector('[data-pane="${kind}"]');
    const box = (e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
    const row = document.querySelector('#${kind}-list .srow[data-row="${kind}:G1"]');
    const text = row?.querySelector('.srow-text');
    const buttons = row ? [...row.querySelectorAll('[data-row-decision]')] : [];
    const quiet = (e) => { const s = getComputedStyle(e); return s.borderTopWidth === '0px' && s.backgroundColor === 'rgba(0, 0, 0, 0)'; };
    const line = text ? parseFloat(getComputedStyle(text).lineHeight) : 0;
    return { list: box(pane.querySelector('.rows-card')), detail: box(pane.querySelector('.detail')), picked: document.querySelector('#${kind}-list .srow.on')?.dataset.row ?? null,
      shown: document.querySelector('#${kind}-detail h2 span')?.textContent ?? null, first: document.querySelector('#${kind}-list .srow')?.dataset.row ?? null,
      row: row && box(row), text: text && box(text), line, buttons: buttons.map((e) => ({ ...box(e), quiet: quiet(e), word: e.childNodes[0].textContent.trim(), filled: getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)', border: getComputedStyle(e).borderTopWidth, key: e.querySelector('kbd')?.textContent })),
      decide: [...document.querySelectorAll('#${kind}-detail [data-row-decision]')].map((e) => ({ ...box(e), quiet: quiet(e), word: e.childNodes[0].textContent.trim(), filled: getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)', border: getComputedStyle(e).borderTopWidth, key: e.querySelector('kbd')?.textContent })),
      section: [...document.querySelectorAll('#${kind}-list [data-section-approve]')].map((e) => quiet(e)),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data && !!data.project");
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await pressTab(chrome, 'spec'); await chrome.click("document.querySelector('#spec-chips [data-rows=\"spec:decide\"]')"); await chrome.stable("view.row.spec = null"); await chrome.stable("render()");
      await chrome.waitFor(`innerWidth === ${width} && !!document.querySelector('#spec-list [data-row="spec:G1"]')`);
      const spec = await read('spec');
      if (width === 1280) assert.ok(Math.abs(spec.list.top - spec.detail.top) < 0.5, `${width}: the list and the detail start on one line: ${JSON.stringify([spec.list, spec.detail])}`);
      assert.deepEqual([spec.picked, spec.shown], ['spec:G1', 'G1'], `${width}: with nothing picked, the detail opens on the first row shown`);
      assert.deepEqual([spec.buttons.length, spec.decide.map((b) => b.word)], [0, ['Approve', 'Decline']], `${width}: a row carries no decision; the picked row's detail holds it once`);
      assert.ok(spec.decide.every((b) => b.height >= tapTarget(width) && b.border === '1px') && spec.decide[0].filled && !spec.decide[1].filled && spec.decide.map((b) => b.key).join() === 'A,D', `${width}: filled Approve and outlined Decline show their keys and meet the target: ${JSON.stringify(spec.decide)}`);
      assert.deepEqual(spec.section, [], `${width}: Spec group headers carry no Approve all; approval stays per row`);
      if (width === 1280) {
        assert.ok(spec.row.height <= 2 * spec.line + 22 && Math.round(spec.text.height / spec.line) <= 2, `${width}: a one-sentence row takes one or two lines: ${JSON.stringify([spec.row, spec.text, spec.line])}`);
      }
      assert.ok(!spec.overflow, `${width}: nothing runs off the screen`);
      // A filter that hides the pick moves it to the new first row; one that keeps it keeps it.
      await chrome.click("document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
      await chrome.click("document.querySelector('#spec-chips [data-rows=\"spec:all\"]')");
      assert.equal((await read('spec')).picked, 'spec:G2', `${width}: a filter that still shows the pick keeps it`);
      await chrome.click("document.querySelector('#spec-chips [data-rows=\"spec:approved\"]')");
      const moved = await read('spec');
      assert.deepEqual([moved.picked, moved.shown], ['spec:G3', 'G3'], `${width}: a filter that hides the pick moves it to the first row shown`);
      await pressTab(chrome, 'doctrine'); await chrome.stable("view.row.doctrine = null"); await chrome.stable("render()");
      const doctrine = await read('doctrine');
      if (width === 1280) assert.ok(Math.abs(doctrine.list.top - doctrine.detail.top) < 0.5, `${width}: Doctrine's cards start on one line too`);
      assert.ok(doctrine.picked && doctrine.picked === doctrine.first && doctrine.shown === doctrine.first.split(':')[1], `${width}: and Doctrine opens on its first row: ${JSON.stringify([doctrine.picked, doctrine.shown])}`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
