// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Cockpit spec checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import vm from 'node:vm';
import { standardDoctrine } from '../../../../packages/doctrine/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { pageScriptPart4 } from '../../../view/index.js';
import { readPathMap } from '../../../../packages/codemap/index.js';
import { REPOSITORY } from '../../tests/fixtures/source.js';
import {
  AGENT_SHELL_MARKERS,
  SSH_SHELL_MARKERS,
} from '../../../../packages/kernel/index.js';
import {
  tapTarget,
  SPEC,
  machine,
  project,
  build,
  startView,
  styleOf,
  openPage,
  boardOf,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  watchSpecDecisionWait,
  press,
} from '../../tests/fixtures/cockpit/harness.js';

/** Return regex-literal bodies while skipping comments and quoted strings in a hosted script part. */
function regexLiterals(source) {
  const found = [];
  let quote = '', comment = '', canStart = true;
  for (let i = 0; i < source.length;) {
    const c = source[i], next = source[i + 1];
    if (comment === 'line') { if (c === '\n') comment = ''; i++; continue; }
    if (comment === 'block') { if (c === '*' && next === '/') { comment = ''; i += 2; } else i++; continue; }
    if (quote) { if (c === '\\') i += 2; else { if (c === quote) quote = ''; i++; } continue; }
    if (c === '/' && next === '/') { comment = 'line'; i += 2; continue; }
    if (c === '/' && next === '*') { comment = 'block'; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; canStart = false; i++; continue; }
    if (c === '/' && canStart) {
      let body = '', j = i + 1, escaped = false, inClass = false;
      for (; j < source.length; j++) {
        const x = source[j];
        if (!escaped && x === '[') inClass = true;
        if (!escaped && x === ']') inClass = false;
        if (!escaped && x === '/' && !inClass) break;
        body += x;
        if (!escaped && x === '\\') escaped = true; else escaped = false;
      }
      if (j < source.length) { found.push({ body, index: i }); i = j + 1; while (/[a-z]/i.test(source[i] || '')) i++; canStart = false; continue; }
    }
    canStart = /[([{,:;=!?&|+*%^~<>-]/.test(c);
    if (!/\s/.test(c)) i++; else i++;
  }
  return found;
}

test('no hosted page script part loses a regex backslash [N26]', () => {
  const offenders = [];
  // The four hosted page script parts were src/view/page-script-N.js; the path map says where each lives now.
  const parts = [...readPathMap(REPOSITORY)].filter(([from]) => /^src\/view\/page-script-\d+\.js$/u.test(from));
  assert.equal(parts.length, 4, 'the map names all four hosted page script parts');
  for (const [, file] of parts) {
    const source = readFileSync(join(REPOSITORY, file), 'utf8');
    const start = source.indexOf('return `') + 'return `'.length;
    const body = source.slice(start, source.lastIndexOf('`;'));
    for (const literal of regexLiterals(body)) {
      if (/(?<!\\)\\[sdwbSDWBrn]/u.test(literal.body)) {
        const line = body.slice(0, literal.index).split('\n').length + 10;
        offenders.push(`${file}:${line}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `hosted regex escapes need a doubled template-literal backslash: ${offenders.join(', ')}`);
});

test('emitted page script splits decision ids on whitespace [N26]', () => {
  const served = pageScriptPart4({});
  const split = /String\(args\.ids\)\.split\((\/.*?\/)\)/u.exec(served);
  assert.ok(split, 'the served decideRow implementation splits its ids');
  const ids = Function(`return String('G1 G2').split(${split[1]})`)();
  assert.deepEqual(ids, ['G1', 'G2'], 'the emitted page script gives decideRow two row ids');
  const rows = ['spec:G0', 'spec:G1', 'spec:G2', 'spec:G3'];
  const next = rows.slice(rows.findIndex((row) => row === `spec:${ids[0]}`) + 1).find((row) => !ids.includes(row.slice('spec:'.length)));
  assert.equal(next, 'spec:G3', 'after deciding G1 and G2, the next undecided row is G3');
  assert.equal(ids.map((id) => `doctrine:${id}`).join(' '), 'doctrine:G1 doctrine:G2', 'each doctrine row keeps its own qualified id');
});

test('a decision on two spec rows splits their ids on whitespace [B26,N26]', async () => {
  const served = pageScriptPart4({});
  const start = served.indexOf('async function decideRow(');
  const end = served.indexOf('\n}\n\n/**\n * Run a public API move', start) + 2;
  assert.ok(start >= 0 && end > start, 'the test extracts the production decideRow from the served page script');
  const window = { scrollY: 275, scrolls: [], scrollTo(position) { this.scrolls.push(position); } };
  const rowsFor = (kind, ids) => ids.map((id) => ({ dataset: { row: `${kind}:${id}` }, getBoundingClientRect: () => ({ top: 20, bottom: 40 }), scrollIntoView() { throw Error('the next row is already visible'); } }));
  let rows = rowsFor('spec', ['G0', 'G1', 'G2', 'G3']);
  const moves = [];
  const view = { root: 'repo', row: { spec: 'G1', doctrine: 'D1' } };
  const context = {
    snapshot: false, readOnly: false, requests: false, view, window, innerHeight: 900,
    $: (id) => ({ querySelectorAll: () => id === 'spec-list' ? rows : rowsFor('doctrine', ['D1', 'D2', 'D3']) }),
    render() {}, setTimeout() {},
    pageMove: (command, args) => ({ body: { command, args } }),
    boardPath: () => '/moves', api: async (path, body) => { moves.push(body); return { result: {} }; },
    moveMessage: () => 'recorded', refresh: async () => {},
  };
  const decideRow = vm.runInNewContext(`(${served.slice(start, end)})`, context);
  const anchor = { closest: () => null };
  assert.equal(await decideRow('spec', 'spec-approve', { ids: 'G1 G2' }, anchor), true);
  assert.equal(view.row.spec, 'G3', 'the next pick skips both decided rows and keeps the reading position');
  assert.equal(moves[0].args.ids, 'G1 G2', 'the hosted page sends the two spec ids');
  assert.deepEqual(JSON.parse(JSON.stringify(window.scrolls)), [{ top: 275, behavior: 'instant' }, { top: 275, behavior: 'instant' }], 'the page restores the original scroll position');
  rows = rowsFor('doctrine', ['D1', 'D2', 'D3']);
  assert.equal(await decideRow('doctrine', 'spec-approve', { ids: 'D1 D2' }, anchor), true);
  assert.equal(view.row.doctrine, 'D3', 'the doctrine pick advances past both decided rows');
  assert.equal(moves[1].args.ids, 'doctrine:D1 doctrine:D2', 'each doctrine id receives its own prefix in the outgoing move');
});

/** Observe a real Spec control's native pointer sequence and any replacement inside its detail card. */
async function watchSpecPress(chrome, selector) {
  await chrome.stable(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)}), detail = document.querySelector('#spec-detail');
    if (!target || !detail) throw Error('Spec press observer target is missing: ' + ${JSON.stringify(selector)});
    const name = node => node ? { tag: node.tagName, id: node.id, decision: node.dataset.rowDecision || '', connected: node.isConnected } : null;
    const box = node => { const r = node?.getBoundingClientRect(); return r ? { x:r.x, y:r.y, width:r.width, height:r.height } : null; };
    const originalRender = window.render;
    if (typeof originalRender !== 'function') throw Error('Spec press observer cannot instrument the real render function');
    const trace = window.__pullboardSpecPress = { selector:${JSON.stringify(selector)}, target, initial:box(target), events:[], childListRecords:0, renderAttempts:0, removedTarget:false, originalRender };
    window.render = function(...args) { trace.renderAttempts += 1; return originalRender.apply(this, args); };
    const types = ['mousedown', 'mouseup', 'click'];
    trace.listeners = types.map(type => {
      const listener = event => {
        const current = document.querySelector(trace.selector);
        trace.events.push({ type, at:performance.now(), target:name(event.target), intendedConnected:target.isConnected,
          intendedBox:box(target), currentSame:current === target, currentBox:box(current), hit:name(document.elementFromPoint(event.clientX, event.clientY)),
          renderAttempts:trace.renderAttempts, childListRecords:trace.childListRecords, dialogHidden:document.querySelector('#spec-decline-dialog').hidden,
          selected:view.row.spec, path:location.pathname, x:event.clientX, y:event.clientY });
      };
      document.addEventListener(type, listener, true);
      return [type, listener];
    });
    trace.observer = new MutationObserver(records => {
      trace.childListRecords += records.length;
      trace.removedTarget ||= records.some(record => [...record.removedNodes].some(node => node === target || node.contains?.(target)));
    });
    trace.observer.observe(document.body, { childList:true, subtree:true });
  })()`);
  return {
    /** Capture original/current identity, event targets and selected state without changing the page. */
    async snapshot() {
      return JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const trace = window.__pullboardSpecPress, current = document.querySelector(trace.selector);
        const box = node => { const r = node?.getBoundingClientRect(); return r ? { x:r.x, y:r.y, width:r.width, height:r.height } : null; };
        return { width:innerWidth, path:location.pathname, selected:view.row.spec, dialogHidden:document.querySelector('#spec-decline-dialog').hidden,
          originalConnected:trace.target.isConnected, originalBox:box(trace.target), currentSame:current === trace.target, currentBox:box(current),
          childListRecords:trace.childListRecords, renderAttempts:trace.renderAttempts, removedTarget:trace.removedTarget, events:trace.events };
      })())`));
    },
    /** Disconnect only the observers installed for this trace. */
    async dispose() {
      await chrome.stable(`(() => { const trace=window.__pullboardSpecPress; if (!trace) return; trace.observer.disconnect(); for (const [type, listener] of trace.listeners) document.removeEventListener(type, listener, true); window.render=trace.originalRender; delete window.__pullboardSpecPress; })()`);
    },
  };
}

/** Record real filter input and completed Spec renders so a stale row read can name its render provenance. */
async function watchSpecFilter(chrome) {
  await chrome.stable(`(() => {
    const originalRender = window.render;
    if (typeof originalRender !== 'function') throw Error('Spec filter observer cannot instrument the real render function');
    const trace = window.__specFilterTrace = { originalRender, renderCount:0, renderAttemptCount:0, lastRow:null, lastRenderId:null, events:[], attempts:[], renders:[], listeners:[], captureErrors:[] };
    /** Read source state and the row DOM immediately after a completed render. */
    const state = () => {
      const row = document.querySelector('#spec-list [data-row="spec:G1"]');
      const chip = row?.querySelector(':scope > .chip');
      const filter = typeof view === 'object' ? view.rows?.spec ?? null : null;
      const source = typeof data === 'object' ? data.project?.spec?.find(entry => entry.id === 'G1') : null;
      return { readAt:performance.now(), filter, sourceDataStatus:source?.status ?? null, rowStatus:chip?.textContent.trim() ?? null, row };
    };
    /** Keep diagnostic failures from changing the original page action or renderer result. */
    const recordError = error => {
      try { trace.captureErrors.push(String(error?.stack || error)); if (trace.captureErrors.length > 4) trace.captureErrors.shift(); }
      catch { /* Diagnostics never replace the original page behavior. */ }
    };
    /** Preserve the actual renderer while assigning an ordinal and post-render snapshot. */
    window.render = function(...args) {
      const result = originalRender.apply(this, args);
      try {
        const current = state();
        trace.renderAttemptCount += 1;
        if (typeof deferredClickRender !== 'undefined' && deferredClickRender) {
          trace.attempts.push({ at:current.readAt, deferred:true, filter:current.filter, sourceDataStatus:current.sourceDataStatus, rowStatus:current.rowStatus });
          if (trace.attempts.length > 8) trace.attempts.shift();
        } else {
          trace.renderCount += 1;
          trace.lastRow = current.row;
          trace.lastRenderId = trace.renderCount;
          trace.renders.push({ id:trace.renderCount, at:current.readAt, filter:current.filter, sourceDataStatus:current.sourceDataStatus, rowStatus:current.rowStatus });
          if (trace.renders.length > 8) trace.renders.shift();
        }
      } catch (error) { recordError(error); }
      return result;
    };
    /** Record the filter control and pre-handler state for the native pointer sequence. */
    const listen = type => {
      const listener = event => {
        const target = event.target.closest?.('[data-rows^="spec:"]');
        if (!target) return;
        try {
          const current = state();
          trace.events.push({ type, at:current.readAt, target:target.dataset.rows, filter:current.filter, sourceDataStatus:current.sourceDataStatus, rowStatus:current.rowStatus });
          if (trace.events.length > 8) trace.events.shift();
        } catch (error) { recordError(error); }
      };
      document.addEventListener(type, listener, true);
      trace.listeners.push([type, listener]);
    };
    for (const type of ['mousedown', 'mouseup', 'click']) listen(type);
  })()`);
  return {
    /** Restore only the renderer and pointer listeners installed for this measurement. */
    async dispose() {
      try {
        await chrome.stable(`(() => { const trace=window.__specFilterTrace; if (!trace) return; window.render=trace.originalRender; for (const [type, listener] of trace.listeners) document.removeEventListener(type, listener, true); delete window.__specFilterTrace; })()`);
        return null;
      } catch (error) { return String(error?.stack || error); }
    },
  };
}


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
    await chrome.click("document.querySelector('[data-tab=spec]')");
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
      await chrome.click("document.querySelector('[data-tab=spec]')"); await chrome.click("document.querySelector('#spec-chips [data-rows=\"spec:decide\"]')"); await chrome.stable("view.row.spec = null"); await chrome.stable("render()");
      await chrome.waitFor(`innerWidth === ${width} && !!document.querySelector('#spec-list [data-row="spec:G1"]')`);
      const spec = await read('spec');
      if (width === 1280) assert.ok(Math.abs(spec.list.top - spec.detail.top) < 0.5, `${width}: the list and the detail start on one line: ${JSON.stringify([spec.list, spec.detail])}`);
      assert.deepEqual([spec.picked, spec.shown], ['spec:G1', 'G1'], `${width}: with nothing picked, the detail opens on the first row shown`);
      assert.deepEqual([spec.buttons.length, spec.decide.map((b) => b.word)], [0, ['Approve', 'Decline']], `${width}: a row carries no decision; the picked row's detail holds it once`);
      assert.ok(spec.decide.every((b) => b.height >= tapTarget(width) && b.border === '1px') && spec.decide[0].filled && !spec.decide[1].filled && spec.decide.map((b) => b.key).join() === 'A,D', `${width}: filled Approve and outlined Decline show their keys and meet the target: ${JSON.stringify(spec.decide)}`);
      assert.ok(spec.section.length >= 1 && spec.section.every(Boolean), `${width}: Approve all stays quiet on the section header`);
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
      await chrome.click("document.querySelector('[data-tab=doctrine]')"); await chrome.stable("view.row.doctrine = null"); await chrome.stable("render()");
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

test('clause 1: spec rows read as a list, decided in the panel [N26]', { timeout: 300_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Spec list checks.');

  // Each of the four layouts decides two rows on each tab, one approved and one declined, so each tab has eight drafts.
  const drafts = (prefix, from, words) => words.map((w, n) => `- ${prefix}${from + n} [draft, must] ${w} | gate: review\n`).join('');
  const eight = ['The page names its owner.', 'Every list says when it was read.', 'A failed save says why.', 'Dates say which day they were.',
    'Long titles end in an ellipsis.', 'The theme follows the system.', 'Each tab keeps its place.', 'Empty lists say how to start.'];
  const spec = '# Decisions\n\n## S · Screens\n'
    + '- S1 [draft, must] The board loads in under a second. | gate: web test\n'
    + '- S2 [pending] Should the board remember the last tab? | gate: review\n'
    + '- S3 [approved, must] Pages never scroll sideways. | gate: web test\n'
    + drafts('S', 4, eight);
  const box = machine();
  const demo = project(box, 'spec-list', spec, { practice: 'ways.md' });
  // Rules this repo wrote, as drafts: the person decides them as Spec rows are decided. Pullboard's own rules come too.
  writeFileSync(join(demo.repo, 'ways.md'), '# Local rules\n\n## Team\n' + drafts('D', 1, eight));
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-list-chrome-'));
  let chrome;
  /** One tab's rows and detail as they read: each row's chip, gutter, words and lines, and the detail's decision. */
  const read = async (kind) => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const rows = [...document.querySelectorAll('#${kind}-list .srow')].map((row) => {
      const s = getComputedStyle(row), text = row.querySelector('.srow-text');
      return { id: row.dataset.row.slice(${kind.length + 1}), chip: row.querySelector('.chip')?.textContent ?? null, gutter: box(row.querySelector('.row-id')), text: box(text), row: box(row),
        lines: Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight)), buttons: row.querySelectorAll('button').length,
        on: row.classList.contains('on'), tint: s.backgroundColor, edges: [s.borderLeftWidth, s.borderLeftColor].join() === [s.borderRightWidth, s.borderRightColor].join() };
    });
    const detail = document.querySelector('#${kind}-detail');
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
      rows, picked: view.row['${kind}'], shown: detail.querySelector('h2 span')?.textContent ?? null, viewport: innerHeight,
      decide: [...detail.querySelectorAll('[data-row-decision]')].map((b) => ({ word: b.childNodes[0].textContent.trim(), ...box(b) })),
      section: [...document.querySelectorAll('#${kind}-list [data-section-approve]')].map((b) => ({ word: b.childNodes[0].textContent.trim(), height: b.getBoundingClientRect().height, head: !!b.closest('.spec-section-head') })),
    };
  })())`));
  /** A tint is quiet when its colour channels sit close together: grey, not a hue. */
  const neutral = (css) => { const [r, g, b] = (css.match(/[\d.]+/g) || []).map(Number); return Math.max(r, g, b) - Math.min(r, g, b) <= 12; };
  /** Press a key the way a keyboard does, into whatever has focus. */
  const pressKey = async (key, code, keyCode) => {
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, ...(type === 'keyDown' && key.length === 1 ? { text: key, unmodifiedText: key } : {}) });
  };
  /** Tap an element through Chrome's input path at its centre. */
  const tap = async (selector) => {
    await press(chrome, `document.querySelector(${JSON.stringify(selector)})`);
  };
  const filter = async (kind, name) => {
    await chrome.click(`document.querySelector('[data-tab=${kind}]')`); await chrome.click(`document.querySelector('#${kind}-chips [data-rows="${kind}:${name}"]')`);
    await chrome.waitFor(`!document.querySelector('[data-pane=${kind}]').hidden && !!document.querySelector('#${kind}-list .srow')`);
  };
  /** A row as the board records it: Spec rows by id, Doctrine rules by id among the merged rules. */
  const recorded = async (kind, id) => {
    const state = await boardOf(view, demo.repo);
    const row = (kind === 'spec' ? state.spec : state.practice).find((entry) => entry.id === id);
    // An undecided row has no stage of its own, only its status; an approval carries no reason.
    return { stage: row?.stage || row?.status || null, decided: row?.decision ? (row.decision.reason || 'approved') : null };
  };
  const expected = { spec: { decide: [['S1', null], ['S2', 'pending'], ...eight.map((_, n) => [`S${n + 4}`, null])] }, doctrine: { decide: eight.map((_, n) => [`D${n + 1}`, null]) } };
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project?.spec?.length && data.project.practice.some((r) => r.id === 'D8')");
    // Inherited defaults have their own review filter; local proposals still wait for the person's decision.
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        const at = `${width}px ${scheme}`;
        for (const kind of ['spec', 'doctrine']) {
          const tab = `${at} ${kind}`;
          await filter(kind, 'decide');
          let r = await read(kind);
          assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${tab}: no sideways scroll`);
          // Each row is its id in a slim gutter and its words at full width; a chip only where the status is not the filter's.
          const undecidedNow = expected[kind].decide;
          assert.deepEqual(r.rows.map((row) => [row.id, row.chip, row.buttons]), undecidedNow.map(([id, chip]) => [id, kind === 'spec' && chip === 'pending' ? null : chip || 'must', 0]),
            `${tab}: drafts carry their tier, a tierless Spec question leaves the tier slot empty, and no row carries a decision`);
          for (const row of r.rows) {
            assert.ok(row.gutter.width <= 52 && Math.abs(row.text.left - row.gutter.left) < 1 && row.text.right <= row.row.right, `${tab}: ${row.id} starts with its id on the same primary line: ${JSON.stringify(row)}`);
            if (width === 1280) assert.ok(row.lines <= 2, `${tab}: ${row.id}, one sentence, takes one or two lines: ${row.lines}`);
          }
          const picked = r.rows.find((row) => row.on);
          assert.ok(picked && neutral(picked.tint) && picked.edges, `${tab}: the picked row is a quiet neutral tint with no coloured edge: ${JSON.stringify(picked)}`);
          // On Spec, Approve all stays on the section's header.
          if (kind === 'spec') assert.deepEqual(r.section.map((b) => [b.word, b.head, b.height >= tapTarget(width)]), [[`Approve all ${undecidedNow.length} in this section`, true, true]], `${tab}: Approve all stays on the section header`);
          else assert.deepEqual(r.section, [], `${tab}: Doctrine rules are decided one at a time`);

          // With focus in the list the arrows move the pick, A approves and moves on, and D asks why, then records it.
          const [first, second, third] = undecidedNow.filter(([, chip]) => chip === null).map(([id]) => id);
          await tap(`#${kind}-list [data-row="${kind}:${first}"]`);
          await chrome.waitFor(`view.row['${kind}'] === '${first}' && document.activeElement === document.querySelector('#${kind}-list')`);
          // At 375 the detail stacks under the list: tapping a row brings its decision into view.
          if (width === 375) await chrome.waitFor(`(() => { const d = document.querySelector('#${kind}-detail [data-row-decision="approve"]')?.getBoundingClientRect(); return !!d && d.top >= 0 && d.bottom <= innerHeight; })()`, 10_000); // budget: hang ceiling for the selected mobile decision to enter the viewport; no speed threshold.
          // The picked row's detail holds its decision once, a 44px target each.
          const held = await read(kind);
          assert.deepEqual(held.decide.map((b) => b.word), ['Approve', 'Decline'], `${tab}: the picked row's detail holds its decision`);
          assert.ok(held.decide.every((b) => b.height >= tapTarget(width)), `${tab}: each a target, 44px where a finger taps`);
          await pressKey('ArrowDown', 'ArrowDown', 40);
          assert.equal(await chrome.stable(`view.row['${kind}']`), undecidedNow[undecidedNow.findIndex(([id]) => id === first) + 1][0], `${tab}: down moves the pick`);
          await pressKey('ArrowUp', 'ArrowUp', 38);
          assert.equal(await chrome.stable(`view.row['${kind}']`), first, `${tab}: and up moves it back`);
          await pressKey('a', 'KeyA', 65);
          const after = undecidedNow[undecidedNow.findIndex(([id]) => id === first) + 1][0];
          await chrome.waitFor(`!!document.querySelector('#${kind}-list .spec-feedback.ok') && view.row['${kind}'] === '${after}'`, 15_000); // budget: hang ceiling for the saved decision and next row selection; no throughput claim.
          assert.deepEqual([await recorded(kind, first), await recorded(kind, second)], [{ stage: 'approved, pending apply', decided: 'approved' }, { stage: 'draft', decided: null }],
            `${tab}: A approved the picked ${first}, and only ${first}`);
          assert.equal(await chrome.stable(`document.activeElement === document.querySelector('#${kind}-list')`), true, `${tab}: the list keeps focus for the next key`);
          // The pick moved on to the next row; when that is the open question, step past it to a draft.
          if (after !== second) { await pressKey('ArrowDown', 'ArrowDown', 40); await chrome.waitFor(`view.row['${kind}'] === '${second}'`); }
          await pressKey('d', 'KeyD', 68);
          await chrome.waitFor(`!document.querySelector('#spec-decline-dialog').hidden && document.querySelector('#spec-decline-title').textContent === 'Decline ${second}'`);
          // Never while typing in a field: an a in the reason is a letter, not an approval.
          await pressKey('a', 'KeyA', 65);
          assert.equal(await chrome.stable("document.querySelector('#spec-decline-reason').value"), 'a', `${tab}: the key types into the reason`);
          assert.deepEqual(await recorded(kind, second), { stage: 'draft', decided: null }, `${tab}: and decides nothing`);
          await chrome.send('Input.insertText', { text: ' clearer outcome, please' });
          await chrome.click("document.querySelector('#spec-decline-submit')");
          await chrome.waitFor(`document.querySelector('#spec-decline-dialog').hidden && !!document.querySelector('#${kind}-list .spec-feedback.ok')`, 15_000); // budget: hang ceiling for the saved decline and dialog close; no throughput claim.
          assert.deepEqual(await recorded(kind, second), { stage: 'declined, pending apply', decided: 'a clearer outcome, please' }, `${tab}: D declined ${second} with its reason`);
          // The last layout decides the last two drafts, so only the earlier ones have a row after them to stay untouched.
          if (third) assert.deepEqual(await recorded(kind, third), { stage: 'draft', decided: null }, `${tab}: and nothing else`);
          assert.equal(await chrome.stable(`document.activeElement === document.querySelector('#${kind}-list')`), true, `${tab}: the dialog returns to the list`);
          // The two decided rows leave Needs your decision.
          expected[kind].decide = undecidedNow.filter(([id]) => id !== first && id !== second);
          await chrome.waitFor(`![...document.querySelectorAll('#${kind}-list .srow')].some((row) => ['${kind}:${first}', '${kind}:${second}'].includes(row.dataset.row))`, 15_000); // budget: hang ceiling for decided rows to leave Needs; no throughput claim.

          // Under All rows, every row not approved says what it is.
          await filter(kind, 'all');
          r = await read(kind);
          const all = Object.fromEntries(r.rows.map((row) => [row.id, row.chip]));
          // Doctrine keeps the tier in its row slot (landed in 89147f4454); the recorded decision shows only in the detail.
          assert.deepEqual([all[first], all[second]], ['must', 'must'], `${tab}: Spec and Doctrine both keep the tier in the row; the recorded decision shows in the detail, not the row`);
          if (kind === 'spec') assert.deepEqual([all.S2, all.S3], [null, 'must'], `${tab}: Spec never replaces the tier slot with pending or approved status`);
          else assert.deepEqual([all.PB1, all.PB7], ['must', 'To review'], `${tab}: standard rules keep their tier or explicit review state`);
        }
      }
    }

    // A rule that comes with Pullboard is changed in DOCTRINE.md, not decided here: its detail offers no decision, and A does nothing.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1280');
    await filter('doctrine', 'all');
    const standard = await chrome.stable("[...document.querySelectorAll('#doctrine-list .srow')].map((row) => row.dataset.row.slice(9)).find((id) => id.startsWith('PB'))");
    await tap(`#doctrine-list [data-row="doctrine:${standard}"]`);
    await chrome.waitFor(`view.row.doctrine === '${standard}' && document.activeElement === document.querySelector('#doctrine-list')`);
    assert.equal(await chrome.stable("document.querySelectorAll('#doctrine-detail [data-row-decision]').length"), 0, `${standard}: a standard rule's detail offers no decision`);
    await pressKey('a', 'KeyA', 65);
    assert.equal((await recorded('doctrine', standard)).decided, null, `${standard}: A decides nothing on it`);
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('real Chrome records Spec row decisions from the row, detail and confirmed section controls [B26,N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Spec decision checks.');

  /** Click a visible control through Chrome's input path without scrolling the result away. */
  const click = async (chrome, selector) => {
    await press(chrome, `document.querySelector(${JSON.stringify(selector)})`);
  };

  /** Preserve an original native click while recording the landed node, redraws and address. */
  const diagnosticClick = async (chrome, selector, width, label) => {
    const trace = await watchSpecPress(chrome, selector);
    let clickFailure;
    try {
      await click(chrome, selector);
    } catch (error) {
      clickFailure = error;
    } finally {
      try {
        t.diagnostic(`${width}: original ${label}: ${JSON.stringify(await trace.snapshot())}`);
      } catch (error) {
        t.diagnostic(`${width}: original ${label} snapshot failed: ${error.message}`);
      }
      try { await trace.dispose(); }
      catch (error) { if (!clickFailure) clickFailure = error; }
    }
    if (clickFailure) throw clickFailure;
  };

  /** Run the full decision story in a fresh real board and browser at one viewport width. */
  const runWidth = async (width) => {
    const rows = Array.from({ length: 29 }, (_, index) => `- G${index + 1} [draft, must] Goal ${index + 1}. | gate: web test`);
    const spec = `# Decisions\n\n## G · Goals\n${rows.join('\n')}\n\n## K · Follow-up\n- K1 [draft, must] Follow-up one. | gate: web test\n- K2 [draft, must] Follow-up two. | gate: web test\n`;
    const box = machine();
    const demo = project(box, `spec-decisions-${width}`, spec);
    const view = await startView(box);
    const profile = mkdtempSync(join(tmpdir(), `pullboard-spec-decisions-${width}-`));
    let chrome;
    let diagnostics;
    try {
      chrome = await openSnapshotChrome(executable, view.link.href, profile);
      await chrome.waitFor("typeof data === 'object' && !!data && !!data.project");
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.click("document.querySelector('[data-tab=spec]')");
      await chrome.waitFor(`innerWidth === ${width} && !!document.querySelector('#spec-list [data-row="spec:G1"]')`);
      await chrome.click("document.querySelector('#spec-chips [data-rows=\"spec:all\"]')");
      await chrome.waitFor("document.querySelector('#spec-list [data-row=\"spec:G2\"]') && document.querySelector('#spec-chips [data-rows=\"spec:decide\"] b')?.textContent === '31'");
      const geometry = JSON.parse(await chrome.stable(`JSON.stringify({
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        controls: [...document.querySelectorAll('#spec-list button[data-row-decision],#spec-list button[data-section-approve]')].map(e=>({height:e.getBoundingClientRect().height})),
        rows: [...document.querySelectorAll('#spec-list .srow')].map(row=>{
          const chip=row.querySelector('.spec-row-side .chip');
          const words=[...(row.querySelector('.srow-text')?.childNodes||[])].find(n=>n.nodeType===3&&n.textContent.trim());
          if (!chip || !words) return {id:row.dataset.row, missing:true};
          const range=document.createRange(); range.selectNodeContents(words);
          const a=chip.getBoundingClientRect(), b=range.getClientRects()[0];
          return {id:row.dataset.row, intersects:a.right>b.left && a.left<b.right && a.bottom>b.top && a.top<b.bottom};
        })
      })`));
      assert.equal(geometry.overflow, false, `${width}: Spec has no horizontal overflow`);
      assert.deepEqual(geometry.controls.filter((control) => control.height < tapTarget(width)), [], `${width}: row and section controls meet the target`);
      assert.deepEqual(geometry.rows.filter((row) => row.missing), [], `${width}: row status and text are present for every fixture row`);
      if (width === 1280) assert.deepEqual(geometry.rows.filter((row) => row.intersects), [], '1280: stage chips never cover row text');

      await chrome.click("document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
      await chrome.waitFor("document.querySelector('#spec-detail h2 span')?.textContent === 'G2'");
      assert.ok(await chrome.stable("document.querySelector('#spec-detail [data-row-decision=approve]') && document.querySelector('#spec-detail [data-row-decision=decline]')"), `${width}: selected G2 has both detail decisions`);
      diagnostics = await watchSpecDecisionWait(chrome);
      // Picked from the list, A approves G1, and the pick moves on to the next row.
      await click(chrome, '#spec-list [data-row="spec:G1"]');
      const specFocusCondition = "view.row.spec === 'G1' && document.activeElement === document.querySelector('#spec-list')";
      await diagnostics.waitFor(specFocusCondition);
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, ...(type === 'keyDown' ? { text: 'a', unmodifiedText: 'a' } : {}) });
      await chrome.waitFor("!!document.querySelector('#spec-list .spec-feedback.ok,#spec-list .spec-feedback.no')");
      let state = await boardOf(view, demo.repo);
      assert.equal(state.spec.find((row) => row.id === 'G1')?.stage, 'approved, pending apply', `${width}: A approves the picked G1`);
      assert.equal(state.spec.find((row) => row.id === 'G2')?.decision, undefined, `${width}: and nothing else`);
      await chrome.waitFor("view.row.spec === 'G2' && document.querySelector('#spec-detail h2 span')?.textContent === 'G2'");
      assert.ok(await chrome.stable(`(() => { const e=document.querySelector('#spec-list [data-row="spec:G2"]'); const r=e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`), `${width}: next undecided G2 stays in the viewport after G1 approval`);
      assert.equal(await chrome.stable("document.querySelector('#spec-chips [data-rows=\"spec:decide\"] b').textContent"), '30', `${width}: Needs your decision excludes the decided row`);
      if (width === 1280) assert.ok(await chrome.stable(`(() => {
        const row=document.querySelector('#spec-list [data-row="spec:G1"]');
        const chip=row.querySelector('.spec-row-side .chip').getBoundingClientRect();
        const words=[...row.querySelector('.srow-text').childNodes].find(n=>n.nodeType===3&&n.textContent.trim());
        const range=document.createRange(); range.selectNodeContents(words); const text=range.getClientRects()[0];
        return chip.right <= text.left || chip.left >= text.right || chip.bottom <= text.top || chip.top >= text.bottom;
      })()`), '1280: the approved row tier does not cover row text');

      await chrome.click("document.querySelector('#spec-chips [data-rows=\"spec:decide\"]')");
      assert.equal(await chrome.stable("!!document.querySelector('#spec-list [data-row=\"spec:G1\"]')"), false, `${width}: approval immediately leaves Needs your decision`);
      await chrome.click("document.querySelector('#spec-chips [data-rows=\"spec:all\"]')");

      await diagnosticClick(chrome, '#spec-detail [data-row-decision="decline"]', width, 'detail decline before cancel');
      assert.ok(await chrome.stable("!document.querySelector('#spec-decline-dialog').hidden && document.querySelector('#spec-decline-title').textContent === 'Decline G2'"), `${width}: G2 decline opens the reason form`);
      assert.ok(await chrome.stable(`[...document.querySelectorAll('#spec-decline-dialog input,#spec-decline-dialog button')].every(e => e.getBoundingClientRect().height >= ${tapTarget(width)})`), `${width}: decline reason and controls meet the 44px target`);
      await click(chrome, '#spec-decline-cancel');
      state = await boardOf(view, demo.repo);
      assert.equal(state.events.filter((event) => event.event_kind === 'row_decision').length, 1, `${width}: cancelling decline records no event`);
      assert.equal(state.spec.find((row) => row.id === 'G2')?.decision, undefined, `${width}: cancelling leaves G2 undecided`);

      await diagnosticClick(chrome, '#spec-detail [data-row-decision="decline"]', width, 'detail decline before saved decision');
      await chrome.stable("document.querySelector('#spec-decline-reason').value = 'Needs a clearer outcome'");
      box.run(demo.repo, 'shout', 'person', `refresh probe ${width}`);
      await chrome.waitFor(`data.project.shouts.some(shout => shout.shout_text === 'refresh probe ${width}')`);
      assert.equal(await chrome.stable("document.querySelector('#spec-decline-reason').value"), 'Needs a clearer outcome', `${width}: typed reason survives a live refresh`);
      // A background scroll must not refuse a fixed dialog button that stays under the native pointer.
      if (width === 375) await chrome.stable(`(() => {
        window.__pullboardScrollProbe = null;
        window.addEventListener('mousemove', () => {
          const target = document.querySelector('#spec-decline-submit');
          const box = () => { const r=target.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; };
          const before={ scrollX, scrollY, box:box() };
          window.scrollBy({ top:-49, left:0, behavior:'instant' });
          window.__pullboardScrollProbe={ before, after:{scrollX, scrollY, box:box()}, connected:target.isConnected };
        }, { once:true });
      })()`);
      await diagnosticClick(chrome, '#spec-decline-submit', width, 'decline submit');
      if (width === 375) {
        const scrollProbe = JSON.parse(await chrome.stable('JSON.stringify(window.__pullboardScrollProbe)'));
        assert.ok(scrollProbe?.connected, 'the real pointer moved over the connected fixed dialog target');
        assert.equal(scrollProbe.before.scrollY - scrollProbe.after.scrollY, 49, 'the background document scrolls during pointer movement');
        assert.deepEqual(scrollProbe.after.box, scrollProbe.before.box, 'the fixed target retains its exact viewport geometry');
      }
      await chrome.waitFor("!!document.querySelector('#spec-detail .spec-feedback.ok,#spec-detail .spec-feedback.no')");

      await chrome.stable("window.__confirmCalls = 0; window.confirm = () => { window.__confirmCalls += 1; return false; }");
      const sectionSelector = `#spec-list [data-section-approve]`;
      const followUp = `[...document.querySelectorAll(${JSON.stringify(sectionSelector)})].find(e=>e.parentElement.querySelector('h4')?.textContent.includes('Follow-up'))`;
      await chrome.click(followUp);
      await chrome.waitFor("!document.querySelector('#spec-approve-dialog').hidden");
      assert.match(await chrome.stable("document.querySelector('#spec-approve-title').textContent"), /Approve all 2 undecided rows in/, `${width}: section approval asks for confirmation in the page`);
      assert.ok(await chrome.stable(`[...document.querySelectorAll('#spec-approve-dialog button')].every(e => e.getBoundingClientRect().height >= ${tapTarget(width)})`), `${width}: the Approve all confirmation's controls meet the 44px target`);
      await click(chrome, '#spec-approve-cancel');
      await chrome.waitFor("document.querySelector('#spec-approve-dialog').hidden");
      state = await boardOf(view, demo.repo);
      assert.equal(await chrome.stable("!!document.querySelector('#spec-list .spec-feedback')"), false, `${width}: cancelling the confirmation starts no move`);
      assert.equal(state.events.filter((event) => event.event_kind === 'row_decision').length, 2, `${width}: cancelling section confirmation records no events`);
      assert.equal(state.spec.find((row) => row.id === 'K1')?.decision, undefined, `${width}: cancelled section approval leaves K1 undecided`);

      await chrome.click(followUp);
      await chrome.waitFor("!document.querySelector('#spec-approve-dialog').hidden");
      await click(chrome, '#spec-approve-submit');
      await chrome.waitFor("['K1','K2'].every(id => data.project.spec.find(row => row.id === id)?.stage === 'approved, pending apply' && document.querySelector('#spec-list [data-row=\"spec:' + id + '\"] .spec-row-side .chip')?.textContent === 'must')");
      state = await boardOf(view, demo.repo);
      const decisions = state.events.filter((event) => event.event_kind === 'row_decision');
      assert.equal(decisions.length, 4, `${width}: approve, decline and two section rows produce four events`);
      assert.deepEqual(decisions.map((event) => event.event_by), ['person', 'person', 'person', 'person'], `${width}: every decision is recorded by the person`);
      assert.deepEqual(decisions.map((event) => JSON.parse(event.event_detail).channel), ['view', 'view', 'view', 'view'], `${width}: every decision uses the view channel`);
      assert.equal(state.spec.find((row) => row.id === 'G2')?.stage, 'declined, pending apply', `${width}: G2 shows its pending decline stage`);
      assert.equal(state.spec.find((row) => row.id === 'G2')?.decision?.reason, 'Needs a clearer outcome', `${width}: decline reason is in board state`);
      assert.equal(state.spec.find((row) => row.id === 'K1')?.stage, 'approved, pending apply', `${width}: K1 was approved`);
      assert.equal(state.spec.find((row) => row.id === 'K2')?.stage, 'approved, pending apply', `${width}: K2 was approved`);
      assert.equal(state.spec.find((row) => row.id === 'G3')?.decision, undefined, `${width}: other section rows remain undecided`);
      if (width === 1280) assert.ok(await chrome.stable(`['G1','G2','K1','K2'].every(id => {
        const row=document.querySelector('#spec-list [data-row="spec:'+id+'"]');
        const chip=row.querySelector('.spec-row-side .chip').getBoundingClientRect();
        const words=[...row.querySelector('.srow-text').childNodes].find(n=>n.nodeType===3&&n.textContent.trim());
        const range=document.createRange(); range.selectNodeContents(words); const text=range.getClientRects()[0];
        return chip.right <= text.left || chip.left >= text.right || chip.bottom <= text.top || chip.top >= text.bottom;
      })`), '1280: the tier of every pending decision has room beside its row text');
      await chrome.click("document.querySelector('#spec-chips [data-rows=\"spec:decide\"]')");
      await chrome.waitFor("document.querySelector('#spec-list [data-row=\"spec:G3\"]') && !document.querySelector('#spec-list [data-row=\"spec:G1\"]') && !document.querySelector('#spec-list [data-row=\"spec:G2\"]') && !document.querySelector('#spec-list [data-row=\"spec:K1\"]') && !document.querySelector('#spec-list [data-row=\"spec:K2\"]')");
      assert.ok(await chrome.stable("document.querySelector('#spec-chips [data-rows=\"spec:decide\"]').innerText.includes('27')"), `${width}: Needs your decision excludes all four decided rows`);
      assert.equal(await chrome.stable('window.__confirmCalls'), 0, `${width}: Approve all never asks the browser's confirm dialog`);
      assert.deepEqual(chrome.exceptions, [], `${width}: Chrome reports no uncaught exceptions`);
    } finally {
      try { await diagnostics?.dispose(); }
      finally {
        try { if (chrome) await closeSnapshotChrome(chrome); }
        finally {
          try { await view.stop(); }
          finally { rmSync(profile, { recursive: true, force: true }); }
        }
      }
    }
  };

  await runWidth(375);
  await runWidth(1280);
});

test('approve all records its rows without the browser confirm dialog [B26,N26]', { timeout: 120_000 }, async () => { // budget: hang-only ceiling for Chrome startup, one in-page confirmation and the recorded decisions.
  const executable = chromeExecutable();
  assert.ok(executable, 'the Approve all check needs real Chrome');
  const spec = '# Approve all\n\n## G · Goals\n- G1 [draft, must] First goal. | gate: web test\n- G2 [draft, must] Second goal. | gate: web test\n- G3 [draft, must] Third goal. | gate: web test\n\n## K · Follow-up\n- K1 [draft, must] Follow-up one. | gate: web test\n';
  const box = machine();
  const demo = project(box, 'spec-approve-all', spec);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-approve-all-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.click("document.querySelector('[data-tab=spec]')");
    await chrome.waitFor("!!document.querySelector('#spec-list [data-row=\"spec:G3\"]') && !!document.querySelector('#spec-list [data-section-approve]')");
    // A dismissed or blocked browser dialog answers false; the press must not depend on it.
    await chrome.stable("window.__confirmCalls = 0; window.confirm = () => { window.__confirmCalls += 1; return false; }");
    await press(chrome, "[...document.querySelectorAll('#spec-list [data-section-approve]')].find(e => e.parentElement.querySelector('h4')?.textContent.includes('Goals'))");
    await chrome.waitFor("!document.querySelector('#spec-approve-dialog').hidden");
    assert.match(await chrome.stable("document.querySelector('#spec-approve-title').textContent"), /^Approve all 3 undecided rows in “.*Goals”\?$/u, 'the page asks about the section and its count itself');
    assert.equal(await chrome.stable("document.querySelector('#spec-approve-rows').textContent"), 'Rows: G1, G2, G3', 'the confirmation names the rows it will approve');
    assert.equal(await chrome.stable('document.activeElement?.id'), 'spec-approve-submit', 'the confirmation takes focus on its Approve button');
    await press(chrome, "document.querySelector('#spec-approve-submit')");
    await chrome.waitFor("document.querySelector('#spec-approve-dialog').hidden && !!document.querySelector('#spec-list .spec-feedback.ok,#spec-list .spec-feedback.no')", 15_000); // budget: hang ceiling for the recorded decision and its note; no throughput claim.
    assert.equal(await chrome.stable("document.querySelector('#spec-list .spec-feedback').textContent"), 'approved rows G1 G2 G3 (pending apply)', 'the note beside the rows says what the board recorded');
    const state = await boardOf(view, demo.repo);
    assert.deepEqual(['G1', 'G2', 'G3'].map((id) => state.spec.find((row) => row.id === id)?.stage), ['approved, pending apply', 'approved, pending apply', 'approved, pending apply'], 'each row the confirmation named is approved');
    assert.equal(state.spec.find((row) => row.id === 'K1')?.decision, undefined, 'a row in another section stays undecided');
    const decisions = state.events.filter((event) => event.event_kind === 'row_decision');
    assert.deepEqual(decisions.map((event) => [event.event_by, JSON.parse(event.event_detail).channel]), [['person', 'view'], ['person', 'view'], ['person', 'view']], 'the person recorded one decision per row through the view');
    assert.equal(await chrome.stable('window.__confirmCalls'), 0, "Approve all never asks the browser's confirm dialog");
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
  } finally {
    try { if (chrome) await closeSnapshotChrome(chrome); }
    finally {
      try { await view.stop(); }
      finally { rmSync(profile, { recursive: true, force: true }); }
    }
  }
});

// #612: the in-page confirmation (#581) replaced window.confirm, which blocked the page. Opened on one board, it must
// never record on another: the page behind it is inert, Tab stays inside it, and leaving the board closes it.
test('approve all stays on the board it was opened on [B26,N26]', { timeout: 150_000 }, async () => { // budget: hang-only ceiling for Chrome startup, two boards and their recorded decisions.
  const executable = chromeExecutable();
  assert.ok(executable, 'the Approve all board check needs real Chrome');
  const spec = '# Same rows\n\n## G · Goals\n- G1 [draft, must] First goal. | gate: web test\n- G2 [draft, must] Second goal. | gate: web test\n';
  const box = machine();
  const alpha = project(box, 'approve-alpha', spec);
  const beta = project(box, 'approve-beta', spec);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-approve-board-'));
  let chrome;
  /** Each board's G rows as the API reports them: status, stage and any decision. */
  const decided = async (board) => JSON.stringify((await boardOf(view, board.repo)).spec.filter((row) => row.id.startsWith('G')).map((row) => [row.id, row.status, row.stage ?? null, row.decision ?? null]));
  /** One real key press, as Chrome's own keyboard delivers it; Enter carries its text, so it activates a button. */
  const key = async (name, code, keyCode, modifiers = 0) => {
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: keyCode, modifiers, ...(name === 'Enter' ? { text: '\r' } : {}) });
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode, modifiers });
  };
  const open = "!document.querySelector('#spec-approve-dialog').hidden";
  const goals = "[...document.querySelectorAll('#spec-list [data-section-approve]')].find(e => e.parentElement.querySelector('h4')?.textContent.includes('Goals'))";
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor(`typeof data === 'object' && data?.project?.root === ${JSON.stringify(alpha.repo)} && !!document.querySelector('#proj-list [data-root=${JSON.stringify(beta.repo)}]')`);
    await chrome.click("document.querySelector('[data-tab=spec]')");
    await chrome.waitFor(`!!(${goals})`);
    const untouched = { alpha: await decided(alpha), beta: await decided(beta) };
    assert.ok(!untouched.beta.includes('approved'), `board B starts with no approval: ${untouched.beta}`);
    await press(chrome, goals);
    await chrome.waitFor(open);

    // Tab and Shift+Tab try to leave the confirmation for the project list, and to switch to board B with Enter.
    const stops = [];
    for (let step = 0; step < 40; step++) {
      await key('Tab', 'Tab', 9, step % 5 === 4 ? 8 : 0);
      const at = JSON.parse(await chrome.stable("JSON.stringify({ inside: !!document.activeElement?.closest('#spec-approve-dialog'), root: document.activeElement?.dataset?.root ?? null })"));
      stops.push(at);
      if (at.root === beta.repo) {
        await key('Enter', 'Enter', 13);
        await chrome.waitFor(`view.root === ${JSON.stringify(beta.repo)} && data?.project?.root === ${JSON.stringify(beta.repo)}`);
        break;
      }
    }
    const left = JSON.parse(await chrome.stable(`JSON.stringify({ root: view.root, open: ${open}, inertBehind: !!document.querySelector('.shell')?.inert })`));
    // Whatever the keys reached, a confirmation still open on board B is pressed, as a person would press it.
    if (left.open && left.root === beta.repo) {
      await press(chrome, "document.querySelector('#spec-approve-submit')");
      await chrome.waitFor("!!document.querySelector('#spec-list .spec-feedback')", 15_000); // budget: hang ceiling for a recorded decision's note; no throughput claim.
    }
    assert.equal(await decided(beta), untouched.beta, `no row on board B is ever approved: ${JSON.stringify({ left, stops })}`);
    assert.ok(stops.every((stop) => stop.inside), `Tab and Shift+Tab stay inside the confirmation: ${JSON.stringify(stops)}`);
    assert.deepEqual([left.root, left.open, left.inertBehind], [alpha.repo, true, true], 'board B is unreachable while the confirmation is open, and the page behind it is inert');

    // A switch the confirmation does not see, such as a link, closes it and records nothing on either board.
    await chrome.stable(`switchTo(${JSON.stringify(beta.repo)})`);
    await chrome.waitFor(`!(${open}) && view.approvingAll === null && data?.project?.root === ${JSON.stringify(beta.repo)} && !document.querySelector('.shell').inert`);
    await chrome.stable("document.querySelector('#spec-approve-form').requestSubmit()");
    // Back to board A, then Back in history while the confirmation is open: it closes again.
    await chrome.stable(`switchTo(${JSON.stringify(alpha.repo)})`);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && !!(${goals})`);
    await press(chrome, goals);
    await chrome.waitFor(open);
    await chrome.stable('history.back()');
    await chrome.waitFor(`!(${open}) && view.approvingAll === null`);
    assert.deepEqual([await decided(alpha), await decided(beta)], [untouched.alpha, untouched.beta], 'leaving the board records nothing on either board');

    // Opened and approved on board A, it records on board A only.
    await chrome.stable(`switchTo(${JSON.stringify(alpha.repo)})`);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && !!(${goals})`);
    await press(chrome, goals);
    await chrome.waitFor(open);
    await press(chrome, "document.querySelector('#spec-approve-submit')");
    await chrome.waitFor("!!document.querySelector('#spec-list .spec-feedback.ok,#spec-list .spec-feedback.no')", 15_000); // budget: hang ceiling for the recorded decision and its note; no throughput claim.
    const state = await boardOf(view, alpha.repo);
    assert.deepEqual(['G1', 'G2'].map((id) => state.spec.find((row) => row.id === id)?.stage), ['approved, pending apply', 'approved, pending apply'], 'board A records the rows its confirmation named');
    assert.equal(await decided(beta), untouched.beta, 'and board B still has none');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
  } finally {
    try { if (chrome) await closeSnapshotChrome(chrome); }
    finally {
      try { await view.stop(); }
      finally { rmSync(profile, { recursive: true, force: true }); }
    }
  }
});

// #616: the decline-with-reason dialog has the same reach as Approve all's confirmation (#612). Opened on one board, it
// must never record the person's decline on another: the page behind it is inert, Tab stays inside it, and leaving the
// board closes it.
test('a decline stays on the board it was opened on [B26,N26]', { timeout: 150_000 }, async () => { // budget: hang-only ceiling for Chrome startup, two boards and their recorded decisions.
  const executable = chromeExecutable();
  assert.ok(executable, 'the decline board check needs real Chrome');
  const spec = '# Same rows\n\n## G · Goals\n- G1 [draft, must] First goal. | gate: web test\n- G2 [draft, must] Second goal. | gate: web test\n';
  const box = machine();
  const alpha = project(box, 'decline-alpha', spec);
  const beta = project(box, 'decline-beta', spec);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-decline-board-'));
  let chrome;
  /** Each board's G rows as the API reports them: status, stage and any decision. */
  const decided = async (board) => JSON.stringify((await boardOf(view, board.repo)).spec.filter((row) => row.id.startsWith('G')).map((row) => [row.id, row.status, row.stage ?? null, row.decision ?? null]));
  /** One real key press, as Chrome's own keyboard delivers it; Enter carries its text, so it activates a button. */
  const key = async (name, code, keyCode, modifiers = 0) => {
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: keyCode, modifiers, ...(name === 'Enter' ? { text: '\r' } : {}) });
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode, modifiers });
  };
  const open = "!document.querySelector('#spec-decline-dialog').hidden";
  /** Open the decline dialog for G1 on the board shown, with a reason typed as the person types it. */
  const askG1 = async () => {
    await press(chrome, "document.querySelector('#spec-list [data-row=\"spec:G1\"]')");
    await chrome.waitFor("!!document.querySelector('#spec-detail [data-row-decision=\"decline\"]')");
    await press(chrome, "document.querySelector('#spec-detail [data-row-decision=\"decline\"]')");
    await chrome.waitFor(`${open} && document.activeElement?.id === 'spec-decline-reason'`);
    await chrome.send('Input.insertText', { text: 'needs a clearer outcome' });
  };
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor(`typeof data === 'object' && data?.project?.root === ${JSON.stringify(alpha.repo)} && !!document.querySelector('#proj-list [data-root=${JSON.stringify(beta.repo)}]')`);
    await chrome.click("document.querySelector('[data-tab=spec]')");
    await chrome.waitFor("!!document.querySelector('#spec-list [data-row=\"spec:G1\"]')");
    const untouched = { alpha: await decided(alpha), beta: await decided(beta) };
    assert.ok(!untouched.beta.includes('declined'), `board B starts with no decline: ${untouched.beta}`);
    await askG1();

    // Tab and Shift+Tab try to leave the dialog for the project list, and to switch to board B with Enter.
    const stops = [];
    for (let step = 0; step < 40; step++) {
      await key('Tab', 'Tab', 9, step % 5 === 4 ? 8 : 0);
      const at = JSON.parse(await chrome.stable("JSON.stringify({ inside: !!document.activeElement?.closest('#spec-decline-dialog'), root: document.activeElement?.dataset?.root ?? null })"));
      stops.push(at);
      if (at.root === beta.repo) {
        await key('Enter', 'Enter', 13);
        await chrome.waitFor(`view.root === ${JSON.stringify(beta.repo)} && data?.project?.root === ${JSON.stringify(beta.repo)}`);
        break;
      }
    }
    const left = JSON.parse(await chrome.stable(`JSON.stringify({ root: view.root, open: ${open}, inertBehind: !!document.querySelector('.shell')?.inert })`));
    // Whatever the keys reached, a dialog still open on board B is submitted, as a person would submit it.
    if (left.open && left.root === beta.repo) {
      await press(chrome, "document.querySelector('#spec-decline-submit')");
      await chrome.waitFor("!!document.querySelector('#spec-detail .spec-feedback,#spec-list .spec-feedback')", 15_000); // budget: hang ceiling for a recorded decision's note; no throughput claim.
    }
    assert.equal(await decided(beta), untouched.beta, `no row on board B is ever declined: ${JSON.stringify({ left, stops })}`);
    assert.ok(stops.every((stop) => stop.inside), `Tab and Shift+Tab stay inside the dialog: ${JSON.stringify(stops)}`);
    assert.deepEqual([left.root, left.open, left.inertBehind], [alpha.repo, true, true], 'board B is unreachable while the dialog is open, and the page behind it is inert');

    // A switch the dialog does not see, such as a link, closes it and records nothing on either board.
    await chrome.stable(`switchTo(${JSON.stringify(beta.repo)})`);
    await chrome.waitFor(`!(${open}) && !view.declining && data?.project?.root === ${JSON.stringify(beta.repo)} && !document.querySelector('.shell').inert`);
    await chrome.stable("document.querySelector('#spec-decline-reason').value = 'still typed'; document.querySelector('#spec-decline-form').requestSubmit()");
    // Back to board A, then Back in history while the dialog is open: it closes again.
    await chrome.stable(`switchTo(${JSON.stringify(alpha.repo)})`);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && !!document.querySelector('#spec-list [data-row="spec:G1"]')`);
    await askG1();
    await chrome.stable('history.back()');
    await chrome.waitFor(`!(${open}) && !view.declining`);
    assert.deepEqual([await decided(alpha), await decided(beta)], [untouched.alpha, untouched.beta], 'leaving the board records nothing on either board');

    // Opened and submitted on board A, it declines G1 on board A only, with its reason.
    await chrome.stable(`switchTo(${JSON.stringify(alpha.repo)})`);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && !!document.querySelector('#spec-list [data-row="spec:G1"]')`);
    await askG1();
    await press(chrome, "document.querySelector('#spec-decline-submit')");
    await chrome.waitFor("!!document.querySelector('#spec-detail .spec-feedback.ok,#spec-detail .spec-feedback.no,#spec-list .spec-feedback.ok,#spec-list .spec-feedback.no')", 15_000); // budget: hang ceiling for the recorded decision and its note; no throughput claim.
    const g1 = (await boardOf(view, alpha.repo)).spec.find((row) => row.id === 'G1');
    assert.deepEqual([g1?.decision?.decision, g1?.decision?.reason], ['decline', 'needs a clearer outcome'], 'board A records the decline and its reason');
    assert.equal(await decided(beta), untouched.beta, 'and board B still has none');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
  } finally {
    try { if (chrome) await closeSnapshotChrome(chrome); }
    finally {
      try { await view.stop(); }
      finally { rmSync(profile, { recursive: true, force: true }); }
    }
  }
});

test('a pending Spec question can be answered in the view [I1,B26]', { timeout: 120_000 }, async () => { // budget: hang-only ceiling for native setup, Chrome and one person decision.
  const executable = chromeExecutable();
  assert.ok(executable, 'answering a pending question needs real Chrome');
  const spec = '# Questions\n\n## G · Goals\n- G1 [pending, must] Which store holds the data: SQLite. Choices: SQLite, Postgres. | gate: review\n';
  const box = machine();
  const demo = project(box, 'spec-answer', spec);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-answer-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(demo.repo)}`);
    await press(chrome, "document.querySelector('[data-tab=spec]')");
    await chrome.waitFor("!!document.querySelector('#spec-list [data-row=\"spec:G1\"]')");
    await press(chrome, "document.querySelector('#spec-list [data-row=\"spec:G1\"]')");
    await chrome.waitFor("view.row.spec === 'G1' && !!document.querySelector('#spec-detail form[data-spec-answer=\"G1\"]')");
    assert.deepEqual(JSON.parse(await chrome.stable(`JSON.stringify({
      status: document.querySelector('#spec-detail .chip')?.textContent.trim(),
      answerBox: document.querySelector('#spec-detail [data-spec-answer] input')?.type,
      submit: document.querySelector('#spec-detail [data-spec-answer] button')?.textContent.trim(),
      decisions: [...document.querySelectorAll('#spec-detail [data-row-decision]')].map(button => button.textContent.trim())
    })`)), { status: 'Pending', answerBox: 'text', submit: 'Answer', decisions: [] }, 'a pending question offers an Answer box instead of draft approval or decline controls');
    await chrome.stable("document.querySelector('#spec-answer-G1').value = 'Postgres'; true");
    await press(chrome, "document.querySelector('#spec-detail [data-spec-answer] button[type=submit]')");
    await chrome.waitFor("document.querySelector('#spec-detail .spec-feedback.ok')?.textContent.includes('answered row G1')");
    const state = await boardOf(view, demo.repo);
    const answer = state.spec.find(row => row.id === 'G1');
    const decisions = state.events.filter(event => event.event_kind === 'row_decision');
    assert.equal(answer.stage, 'answered Postgres, pending apply', 'the answer is recorded as the pending row decision');
    assert.equal(answer.decision.text, 'Which store holds the data: Postgres. Choices: SQLite, Postgres.', 'the board stores the exact choice in the answered row text');
    assert.deepEqual(decisions.map(event => [event.event_by, JSON.parse(event.event_detail).channel]), [['person', 'view']], 'the answer uses the person view channel');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
  } finally {
    try { if (chrome) await closeSnapshotChrome(chrome); }
    finally { await view.stop(); rmSync(profile, { recursive: true, force: true }); }
  }
});

test('a refresh keeps the draft and focus in a pending Spec question Answer box [N27,I1]', { timeout: 120_000 }, async () => { // budget: hang-only ceiling for native setup and Chrome.
  const executable = chromeExecutable();
  assert.ok(executable, 'the Answer draft check needs real Chrome');
  const spec = '# Questions\n\n## G · Goals\n- G1 [pending, must] Which store holds the data: SQLite. Choices: SQLite, Postgres. | gate: review\n';
  const box = machine();
  const demo = project(box, 'spec-answer-draft', spec);
  const view = await startView(box);
  const profile = join(box.dir, 'spec-draft-chrome');
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(demo.repo)}`);
    await press(chrome, "document.querySelector('[data-tab=spec]')");
    await chrome.waitFor("!!document.querySelector('#spec-list [data-row=\"spec:G1\"]')");
    await press(chrome, "document.querySelector('#spec-list [data-row=\"spec:G1\"]')");
    await chrome.waitFor("view.row.spec === 'G1' && !!document.querySelector('#spec-detail form[data-spec-answer=\"G1\"]')");
    await chrome.stable("(() => { const box = document.querySelector('#spec-answer-G1'); box.focus(); box.value = 'Postgres, half typed'; box.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await chrome.stable('render()'); // the refresh every poll runs
    const kept = JSON.parse(await chrome.stable(`JSON.stringify({
      value: document.querySelector('#spec-answer-G1')?.value,
      focused: document.activeElement?.id,
    })`));
    assert.deepEqual(kept, { value: 'Postgres, half typed', focused: 'spec-answer-G1' }, 'the refresh keeps what the person typed and where they typed it');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
  } finally {
    try { if (chrome) await closeSnapshotChrome(chrome); }
    finally { await view.stop(); }
  }
});

test('the spec decision wait names its state on timeout [N26]', { timeout: 60_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Spec wait diagnostics.');

  const spec = '# Timeout probe\n\n## G · Goals\n- G1 [draft, must] First goal. | gate: web test\n- G2 [draft, must] Second goal. | gate: web test\n';
  const box = machine();
  const demo = project(box, 'spec-wait-timeout', spec);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-timeout-'));
  let chrome;
  let diagnostics;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.click("document.querySelector('[data-tab=spec]')");
    await chrome.waitFor("!!document.querySelector('#spec-list [data-row=\"spec:G1\"]') && !!document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    diagnostics = await watchSpecDecisionWait(chrome);
    await press(chrome, `document.querySelector('#spec-list [data-row="spec:G1"]')`);
    await chrome.waitFor("view.row.spec === 'G1' && document.activeElement === document.querySelector('#spec-list')");
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await chrome.waitFor("view.row.spec === 'G2'");

    let timeout;
    try { await diagnostics.waitFor('false', 10); } catch (error) { timeout = error; } // budget: declared 10 ms negative timeout diagnostic deadline.
    assert.match(timeout?.message ?? '', /Browser condition did not arrive: false/, 'the test deliberately drives the real wait helper to timeout');
    assert.deepEqual(timeout.diagnostic.selectedRow, 'G2', 'the timeout record names the currently selected row');
    assert.equal(timeout.diagnostic.focusedElement.id, 'spec-list', 'the timeout record names the focused list');
    assert.ok(Array.isArray(timeout.diagnostic.pendingRequests), 'the timeout record includes bounded in-flight requests');
    assert.deepEqual(timeout.diagnostic.lastKeyEvents.slice(-2).map(({ type, key, code }) => [type, key, code]), [
      ['keydown', 'ArrowDown', 'ArrowDown'], ['keyup', 'ArrowDown', 'ArrowDown'],
    ], 'the timeout record includes the last real key events');
  } finally {
    try { await diagnostics?.dispose(); }
    finally {
      try { if (chrome) await closeSnapshotChrome(chrome); }
      finally {
        try { rmSync(profile, { recursive: true, force: true }); }
        finally { await view.stop(); }
      }
    }
  }
});

test('the Spec decline opens its reason form under a 6× CPU throttle [N26]', { timeout: 120_000 }, async (t) => { // budget: Chrome startup plus the actual three-second state poll and cleanup under CPU throttling.
  const executable = chromeExecutable();
  assert.ok(executable, 'the required Spec interaction test needs real Chrome');
  const spec = '# Decline under load\n\n## G · Goals\n- G1 [draft, must] Keep the reviewed result visible. | gate: web test\n';
  const box = machine();
  const demo = project(box, 'spec-decline-load', spec);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-decline-load-'));
  let chrome;
  let controlTrace;
  let refreshTrace;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width:375, height:812, deviceScaleFactor:1, mobile:false });
    await chrome.send('Emulation.setCPUThrottlingRate', { rate:6 });
    await chrome.click("document.querySelector('[data-tab=spec]')");
    await chrome.waitFor("innerWidth === 375 && !!document.querySelector('#spec-list [data-row=\"spec:G1\"]')");
    await press(chrome, "document.querySelector('#spec-list [data-row=\"spec:G1\"]')");
    await chrome.waitFor("!!document.querySelector('#spec-detail [data-row-decision=\"decline\"]')");

    const decline = '#spec-detail [data-row-decision="decline"]';
    controlTrace = await watchSpecPress(chrome, decline);
    try {
      await press(chrome, `document.querySelector(${JSON.stringify(decline)})`);
      const control = await controlTrace.snapshot();
      t.diagnostic(`6× no-refresh control: ${JSON.stringify(control)}`);
      assert.equal(control.dialogHidden, false, 'without an intervening refresh the real detail decline opens its reason form');
      assert.deepEqual(control.events.map(event => event.type), ['mousedown', 'mouseup', 'click'], 'the no-refresh control received one native click');
    } finally {
      await controlTrace.dispose();
      controlTrace = null;
    }
    await press(chrome, "document.querySelector('#spec-decline-cancel')");
    await chrome.waitFor("document.querySelector('#spec-decline-dialog').hidden");

    refreshTrace = await watchSpecPress(chrome, decline);
    const refreshText = 'refresh while Spec decline pointer is held';
    let refreshFailure;
    try {
      await press(chrome, `document.querySelector(${JSON.stringify(decline)})`, { afterMouseDown: async () => {
        box.run(demo.repo, 'shout', 'person', refreshText);
        await chrome.waitFor(`data.project.shouts.some(shout => shout.shout_text === ${JSON.stringify(refreshText)})`, 20_000); // budget: hang-only ceiling for the real view poll to carry the private CLI write while native mouse input is held; no throughput claim.
        t.diagnostic(`6× pointer-held refresh before mouseup: ${JSON.stringify(await refreshTrace.snapshot())}`);
      } });
    } catch (error) {
      refreshFailure = error;
    }
    let refreshed;
    try {
      refreshed = await refreshTrace.snapshot();
      t.diagnostic(`6× pointer-held refresh after mouseup: ${JSON.stringify(refreshed)}`);
    } catch (error) {
      t.diagnostic(`6× pointer-held refresh snapshot failed: ${error.message}`);
      if (!refreshFailure) refreshFailure = error;
    }
    if (refreshFailure) throw refreshFailure;
    assert.equal(refreshed.dialogHidden, false, 'the real Spec decline still opens its reason form when a board refresh arrives during the native press');
    assert.ok(refreshed.events.some(event => event.type === 'click'), `the native release produced a click after the refresh: ${JSON.stringify(refreshed)}`);
    await refreshTrace.dispose();
    refreshTrace = null;
  } finally {
    try { await refreshTrace?.dispose(); }
    finally {
      try { await controlTrace?.dispose(); }
      finally {
        try { if (chrome) await closeSnapshotChrome(chrome); }
        finally {
          try { await view.stop(); }
          finally { rmSync(profile, { recursive:true, force:true }); }
        }
      }
    }
  }
});

// Hang ceiling: four three-tab layouts, native input and real Git/SQLite setup; two 120s journey budgets plus setup headroom.

/** Compare real Items, Spec and Doctrine rendering and native selection across four viewport/theme layouts. Doctrine records take the Spec record grid (landed in 6e59717725 and cead5a98d7), so their geometry is compared to the Spec row; the font stays on the Items row. */
test('clause 1: doctrine and spec rows share the items row [N26]', { timeout: 300_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for shared-row checks.');

  const standard = standardDoctrine();
  const [inherited, overridden, declined] = standard.rows;
  const longGoal = 'A deliberately long requirement keeps all its words in the detail while the shared row cuts its title with an ellipsis. '.repeat(3);
  const longOverride = 'This repository replaces the standard wording with a long rule that must ellipsize in the shared row while remaining complete in the detail. '.repeat(3);
  const spec = '# Shared rows\n\n## G · Goals\n'
    + `- G1 [draft, must] ${longGoal} | gate: browser check | serves: G3\n`
    + '- G2 [pending, aim] A second undecided row keeps the section approval count honest. | gate: browser check\n'
    + '- G3 [approved, must] Approved text remains available in its detail. | gate: browser check\n';
  const box = machine();
  const demo = project(box, 'shared-rows', spec, { practice: 'DOCTRINE.md' });
  const reason = 'The local process already covers this inherited rule.';
  writeFileSync(join(demo.repo, 'DOCTRINE.md'), `# Team doctrine\n\n## Rules\n`
    + `- ${overridden.id} [draft, must] ${longOverride} | gate: doctrine check | serves: ${inherited.id}\n`
    + `- ${declined.id} [wont] ${reason} | gate: doctrine check | serves: ${inherited.id}\n`
    + '\n## Local\n- R1 [approved, must] The repository’s own rule stays in its source section. | gate: local check\n- G1 [approved, must] This doctrine rule shares the citing item. | gate: citation check\n');
  box.run(demo.repo, 'add', 'web', 'A real item citing G1', '--specs', 'G1', '--criterion', 'The requirement is represented by a built item.');
  build(box, demo, 1, 'shared-row.txt');

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-shared-rows-chrome-'));
  let chrome;
  let filterTrace;
  /** Save a full-page proof of the actual rendered tab when a proof folder is requested. */
  const shot = async (kind, width, theme) => {
    if (!process.env.PULLBOARD_ROWS_PROOF) return;
    mkdirSync(process.env.PULLBOARD_ROWS_PROOF, { recursive: true });
    await chrome.stable('window.scrollTo(0, 0)');
    const cssContentSize = JSON.parse(await chrome.stable('JSON.stringify({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight})'));
    const capture = await chrome.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 } });
    writeFileSync(join(process.env.PULLBOARD_ROWS_PROOF, kind + '-' + width + '-' + theme + '.png'), Buffer.from(capture.data, 'base64'));
  };
  /** Capture rendered row geometry and computed row/title type from the live DOM. */
  const rowState = async (selector) => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    const box = e => { if (!e) return null; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
    const style = e => { if (!e) return null; const s=getComputedStyle(e); return {display:s.display,dotColumn:s.gridTemplateColumns.split(" ")[0],gridTemplateAreas:s.gridTemplateAreas,columnGap:s.columnGap,rowGap:s.rowGap,padding:s.padding,fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight}; };
    const title = row?.querySelector('.t'), meta = row?.querySelector('.meta'), source = row?.querySelector('.rule-source, .rule-source-chip'), reason = row?.querySelector('.rule-reason');
    const specRow = row?.classList.contains('spec-record');
    const age = row?.querySelector(specRow ? '.spec-row-side small' : '.row-age');
    const trace = window.__specFilterTrace;
    const currentRow = document.querySelector('#spec-list [data-row="spec:G1"]');
    return {tag:row?.tagName ?? null, className:row?.className ?? '', title:title?.textContent ?? '', titleFull:row?.getAttribute('title') ?? '', titleBox:box(title), titleStyle:title&&{overflow:getComputedStyle(title).textOverflow,whiteSpace:getComputedStyle(title).whiteSpace,lines:Math.ceil(title.getBoundingClientRect().height/parseFloat(getComputedStyle(title).lineHeight))},
      rowBox:box(row), rowStyle:style(row), dot:!!row?.querySelector(':scope > .dot'), meta:meta?.textContent ?? '', metaBox:box(source), source:source?.textContent ?? null, sourceTitle:source?.title ?? null, sourceBox:box(source), reason:reason?.textContent ?? null, reasonBox:box(reason), gate:row?.querySelector('.meta .gate, .meta .doctrine-check')?.textContent ?? null, gateBox:box(row?.querySelector('.meta .gate, .meta .doctrine-check')),
      count:age?.textContent.trim() ?? null, countBox:box(age), status:row?.querySelector(specRow ? '.spec-row-side .chip' : ':scope > .chip')?.textContent.trim() ?? null, statusBox:box(row?.querySelector(specRow ? '.spec-row-side .chip' : ':scope > .chip')), stateIcon:row?.querySelector(':scope > .dot')?.textContent ?? '',
      renderProvenance:trace ? { readAt:performance.now(), currentFilter:typeof view === 'object' ? view.rows?.spec ?? null : null,
        sourceDataStatus:typeof data === 'object' ? data.project?.spec?.find(entry => entry.id === 'G1')?.status ?? null : null,
        events:trace.events.slice(-8), attempts:trace.attempts.slice(-8), renders:trace.renders.slice(-8),
        renderAttemptCount:trace.renderAttemptCount, renderCount:trace.renderCount,
        lastRenderId:trace.lastRenderId, currentRowRenderId:currentRow === trace.lastRow ? trace.lastRenderId : null,
        currentRowIsLastRendered:currentRow === trace.lastRow, captureErrors:trace.captureErrors.slice(-4) } : null,
      overflow:document.documentElement.scrollWidth > document.documentElement.clientWidth, pageWidth:document.documentElement.clientWidth, pageScrollWidth:document.documentElement.scrollWidth};
  })())`));

  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("data?.project?.spec?.some(row => row.id === 'G1') && data?.project?.practice?.some(row => row.id === 'R1')");
    for (const theme of ['light', 'dark']) {
      for (const width of [375, 1280]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${theme})').matches`);
        await press(chrome, "document.querySelector('[data-tab=items]')");
        const item = await rowState('#chain .row[data-item="1"]');
        assert.ok(item?.dot, `${width}px ${theme}: the Items reference row has its status dot`);
        assert.equal(item.overflow, false, `${width}px ${theme}: the Items row has no horizontal overflow`);

        await press(chrome, "document.querySelector('[data-tab=spec]')");
        await press(chrome, "document.querySelector('#spec-chips [data-rows=\"spec:all\"]')");
        const g1 = await rowState('#spec-list [data-row="spec:G1"]');
        const g2 = await rowState('#spec-list [data-row="spec:G2"]');
        assert.match(g1.className, /(?:^|\s)srow(?:\s|$)/u);
        assert.match(g1.className, /(?:^|\s)row(?:\s|$)/u, `${width}px ${theme}: Spec uses the shared Items row component`);
        assert.equal(g1.dot, true);
        assert.equal(g1.overflow, false, `${width}px ${theme}: Spec has no horizontal overflow`);
        assert.equal(g1.count, '1 item', `${width}px ${theme}: G1 shows its exact citation count below the tier`);
        assert.ok(g1.countBox.y >= g1.statusBox.bottom && Math.abs(g1.countBox.right - g1.statusBox.right) < 2, `${width}px ${theme}: the citation count is right-aligned below the tier`);
        assert.equal(g1.status, 'must', `${width}px ${theme}: All rows keeps the tier in its slot`);
        assert.equal(g1.stateIcon, '✎', `${width}px ${theme}: the state circle identifies a draft`);
        assert.equal(g2.count, '0 items', `${width}px ${theme}: an uncited Spec row has an explicit citation count`);
        assert.equal(g2.status, 'aim', `${width}px ${theme}: a pending question retains its declared aim tier`);
        assert.equal(g1.rowStyle.gridTemplateAreas, '"dot main side"', `${width}px ${theme}: Spec uses the approved state, text and side-column grid`);
        assert.equal(g1.rowStyle.fontFamily, item.rowStyle.fontFamily, `${width}px ${theme}: Spec retains the shared row font`);
        assert.equal(g1.titleStyle.overflow, 'ellipsis');
        assert.equal(g1.titleStyle.whiteSpace, 'nowrap');
        assert.equal(g1.titleStyle.lines, 1);
        assert.ok(g1.titleFull.includes(longGoal.slice(0, 40)), `${width}px ${theme}: the full title remains available on the row`);

        const header = JSON.parse(await chrome.stable(`JSON.stringify((() => { const e=document.querySelector('#spec-list .spec-section-head'); return {text:e?.innerText??'', count:e?.querySelector('.section-count')?.textContent.trim()??null, approve:e?.querySelector('[data-section-approve]')?.innerText??null, button:e?.querySelector('[data-section-approve]')?.getBoundingClientRect().height??0}; })())`));
        assert.match(header.text, /Goals/u);
        assert.equal(header.count, '3', `${width}px ${theme}: the section header shows its three rows`);
        assert.match(header.approve ?? '', /Approve all 2/u, `${width}px ${theme}: Spec keeps its two-undecided-row Approve all action`);
        assert.ok(header.button >= tapTarget(width), `${width}px ${theme}: Approve all meets the #371 target size`);

        filterTrace = await watchSpecFilter(chrome);
        let assertionError;
        try {
          await press(chrome, "document.querySelector('#spec-chips [data-rows=\"spec:decide\"]')");
          const draft = await rowState('#spec-list [data-row="spec:G1"]');
          const pending = await rowState('#spec-list [data-row="spec:G2"]');
          const capture = JSON.stringify({ row: draft, currentFilter: draft.renderProvenance?.currentFilter,
            sourceDataStatus: draft.renderProvenance?.sourceDataStatus, rowStatus: draft.status,
            renderAttemptCount: draft.renderProvenance?.renderAttemptCount, renderCount: draft.renderProvenance?.renderCount,
            currentRowRenderId: draft.renderProvenance?.currentRowRenderId,
            events: draft.renderProvenance?.events, attempts: draft.renderProvenance?.attempts, renders: draft.renderProvenance?.renders,
            captureErrors: draft.renderProvenance?.captureErrors });
          assert.equal(draft.status, 'must', `${width}px ${theme}: the filter-implied draft status gives way to its tier; row/render capture ${capture}; ROOT-CAUSE STATUS: NOT PROVEN`);
          assert.equal(pending.status, 'aim', `${width}px ${theme}: the pending question keeps its declared tier; row/render capture ${JSON.stringify({ row: pending, rootCauseStatus: 'NOT PROVEN' })}; ROOT-CAUSE STATUS: NOT PROVEN`);
        } catch (error) {
          assertionError = error;
          throw error;
        } finally {
          const disposeError = await filterTrace.dispose();
          if (disposeError) {
            if (assertionError) assertionError.message += `; filter-observer cleanup also failed: ${disposeError}`;
            else throw new Error(`filter-observer cleanup failed: ${disposeError}`);
          }
          filterTrace = null;
        }
        await press(chrome, "document.querySelector('#spec-chips [data-rows=\"spec:approved\"]')");
        const approved = await rowState('#spec-list [data-row="spec:G3"]');
        assert.equal(approved.status, 'must', `${width}px ${theme}: an approved requirement keeps its tier`);
        assert.equal(approved.stateIcon, '✓', `${width}px ${theme}: the state circle identifies approval`);
        await press(chrome, "document.querySelector('#spec-chips [data-rows=\"spec:all\"]')");
        await press(chrome, "document.querySelector('#spec-list [data-row=\"spec:G1\"]')");
        await chrome.waitFor("document.querySelector('#spec-detail h2 span')?.textContent === 'G1'");
        let detail = await chrome.stable("document.querySelector('#spec-detail').innerText");
        assert.ok(detail.includes(longGoal.trim()) && detail.includes('browser check') && detail.includes('G3') && detail.includes('#1 A real item citing G1'), `${width}px ${theme}: clicking Spec opens full text, gate, served area and citing item`);
        let actions = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#spec-detail [data-row-decision]')].map(e=>({action:e.dataset.rowDecision,text:e.innerText,key:e.querySelector('kbd')?.innerText??null,height:e.getBoundingClientRect().height,background:getComputedStyle(e).backgroundColor,border:getComputedStyle(e).borderTopWidth})))`));
        assert.deepEqual(actions.map(e=>e.action), ['approve','decline']);
        assert.equal(actions[0].key, 'A'); assert.equal(actions[1].key, 'D');
        assert.notEqual(actions[0].background, 'rgba(0, 0, 0, 0)', 'Approve is filled');
        assert.equal(actions[1].background, 'rgba(0, 0, 0, 0)', 'Decline is outlined');
        assert.ok(actions.every(e=>e.height >= tapTarget(width) && e.border === '1px'), `${width}px ${theme}: detail actions meet #371 targets`);

        await shot('spec', width, theme);
        await press(chrome, "document.querySelector('[data-tab=doctrine]')");
        await press(chrome, "document.querySelector('#doctrine-chips [data-rows=\"doctrine:all\"]')");
        const pb1 = await rowState(`#doctrine-list [data-row="doctrine:${inherited.id}"]`);
        const pb2 = await rowState(`#doctrine-list [data-row="doctrine:${overridden.id}"]`);
        const pb3 = await rowState(`#doctrine-list [data-row="doctrine:${declined.id}"]`);
        const local = await rowState('#doctrine-list [data-row="doctrine:R1"]');
        assert.equal(pb1.source, 'Standard', `${width}px ${theme}: an inherited row uses the concise Standard chip`);
        assert.equal(pb1.sourceTitle, `Pullboard v${standard.version}`, `${width}px ${theme}: its packaged version stays available on hover`);
        assert.equal(pb2.source, 'This repo');
        assert.equal(pb3.source, 'This repo');
        assert.equal(local.source, 'This repo');
        for (const row of [pb1,pb2,pb3,local]) {
          assert.match(row.className, /(?:^|\s)srow(?:\s|$)/u);
          assert.match(row.className, /(?:^|\s)row(?:\s|$)/u);
          assert.deepEqual(row.rowStyle, g1.rowStyle, `${width}px ${theme}: every doctrine record shares the Spec record geometry and type`);
          assert.equal(row.rowStyle.fontFamily, item.rowStyle.fontFamily, `${width}px ${theme}: and the Items row font`);
          assert.ok(row.dot && !row.count && !row.overflow, `${width}px ${theme}: uncited rules have a dot, no zero-count marker, and no horizontal overflow`);
        }
        assert.ok(pb2.sourceBox.y > pb2.titleBox.y && Math.abs(pb2.sourceBox.x - pb2.titleBox.x) < 1);
        assert.ok(Math.abs(pb2.sourceBox.y - pb2.gateBox.y) < 2, `${width}px ${theme}: source and gate share the second line`);
        assert.ok(pb3.reason && Math.abs(pb3.reasonBox.y - pb3.sourceBox.y) < 2 && pb3.reasonBox.x > pb3.sourceBox.x, `${width}px ${theme}: a declined reason follows its source on the metadata line`);
        assert.equal(pb2.titleStyle.overflow, 'ellipsis');
        assert.equal(pb2.titleStyle.lines, 1);
        assert.ok(pb2.titleBox.width > 0, `${width}px ${theme}: the full-width detail rule still has a visible title line`);
        const sectionCounts = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#doctrine-list .spec-section-head')].map(e=>({name:e.querySelector('h4')?.innerText??'', count:e.querySelector('.section-count')?.textContent.trim()??null, review:e.querySelector('.doctrine-review-count')?.textContent??null})))`));
        assert.ok(sectionCounts.some(e => e.name.startsWith('PB · Pullboard rules') && e.count === String(standard.rows.length - 2) && e.review === '1 to review'), `${width}px ${theme}: the inherited section excludes the two repository overrides and counts its one awaiting review`);
        assert.equal(sectionCounts.reduce((n, e) => n + Number(e.count), 0), standard.rows.length + 2, `${width}px ${theme}: separated source sections retain every merged rule exactly once`);
        assert.ok(sectionCounts.some(e => e.count === '2'), `${width}px ${theme}: the repo-only section keeps its own row count`);
        const citedRule = await rowState('#doctrine-list [data-row="doctrine:G1"]');
        assert.equal(citedRule.count, '1 item', `${width}px ${theme}: Doctrine counts its actual citing item on line one`);
        await press(chrome, "document.querySelector('#doctrine-list [data-row=\"doctrine:G1\"]')");
        const citedDetail = await chrome.stable("document.querySelector('#doctrine-detail').innerText");
        assert.ok(citedDetail.includes('This doctrine rule shares the citing item.') && citedDetail.includes('Checked in review') && citedDetail.includes('#1 A real item citing G1'), `${width}px ${theme}: Doctrine detail lists the actual item that cites it`);
        const allText = await chrome.stable('document.body.innerText.toLowerCase()');
        assert.equal(allText.includes('standard 1'), false, `${width}px ${theme}: the old label is absent`);

        await press(chrome, `document.querySelector('#doctrine-list [data-row="doctrine:${overridden.id}"]')`);
        await chrome.waitFor(`document.querySelector('#doctrine-detail h2 span')?.textContent === ${JSON.stringify(overridden.id)}`);
        await chrome.stable('window.scrollTo(0, 0)');
        await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
        await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
        const visibleDetail = JSON.parse(await chrome.stable("JSON.stringify((() => {const r=document.querySelector('#doctrine-detail h2').getBoundingClientRect(); return {top:r.top,bottom:r.bottom};})())"));
        assert.ok(visibleDetail.top >= -1 && visibleDetail.top < 900, `${width}px ${theme}: native Enter opens the picked detail in the viewport: ${JSON.stringify(visibleDetail)}`);
        detail = await chrome.stable("document.querySelector('#doctrine-detail').innerText");
        assert.ok(detail.includes(longOverride.trim()) && detail.includes('Checked in review') && detail.includes(inherited.id) && detail.includes('Cited by') && detail.includes('No items yet'), `${width}px ${theme}: Enter on the picked rule opens full detail: ${detail}`);
        assert.ok(!await chrome.stable('document.documentElement.scrollWidth > document.documentElement.clientWidth'), `${width}px ${theme}: no horizontal overflow`);
        await shot('doctrine', width, theme);
      }
    }
    // The same wide layout becomes touch-sized when its primary pointer is coarse.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await chrome.waitFor("matchMedia('(pointer: coarse)').matches");
    for (const kind of ['spec', 'doctrine']) {
      await press(chrome, `document.querySelector('[data-tab=${kind}]')`);
      await press(chrome, `document.querySelector('#${kind}-chips [data-rows="${kind}:all"]')`);
      const id = kind === 'spec' ? 'G1' : overridden.id;
      await press(chrome, `document.querySelector('#${kind}-list [data-row="${kind}:${id}"]')`);
      const targets = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const nodes = [...document.querySelectorAll('#${kind}-list [data-row], #${kind}-list [data-section-approve], #${kind}-detail [data-row-decision]')];
        return {coarse:matchMedia('(pointer: coarse)').matches, tap:getComputedStyle(document.documentElement).getPropertyValue('--tap').trim(),
          heights:nodes.map(node => ({name:node.dataset.row || node.textContent.trim(), height:node.getBoundingClientRect().height}))};
      })())`));
      assert.equal(targets.coarse, true, kind + ': the real wide Chrome viewport has a coarse primary pointer');
      assert.equal(targets.tap, '44px', kind + ': touch uses the accepted 44px sizing token');
      assert.ok(targets.heights.length > 2 && targets.heights.every(target => target.height >= 44), kind + ': rows and both detail decisions meet the touch target: ' + JSON.stringify(targets));
    }
  } finally {
    try { await filterTrace?.dispose(); }
    finally {
      try { if (chrome) await closeSnapshotChrome(chrome); }
      finally {
        rmSync(profile, { recursive: true, force: true });
        await view.stop();
      }
    }
  }
});

/** The decline dialog's submit button keeps its place while the dialog is open, even when an approval note times out under it. */
test('the decline dialog never moves under the pointer [B26,N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to check the decline dialog.');

  // A long list at a phone width: the page ends below the detail, so removing a note above it clamps the page's scroll.
  const rows = Array.from({ length: 24 }, (_, index) => `- G${index + 1} [draft, must] Row ${index + 1} keeps its wording. | gate: review`);
  const spec = '# Decline stability\n\n## G · Goals\n' + rows.join('\n') + '\n';
  const box = machine();
  project(box, 'decline-stable', spec);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-decline-stable-chrome-'));
  let chrome;
  /** One key press, as the keyboard sends it to the focused list. */
  const pressKey = async (key, code, keyCode) => {
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, ...(type === 'keyDown' && key.length === 1 ? { text: key, unmodifiedText: key } : {}) });
  };
  /** The page's scroll and the decline dialog's submit button's box, read in one step. */
  const measure = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const r = document.querySelector('#spec-decline-submit').getBoundingClientRect();
    return { y: scrollY, box: [r.x, r.y, r.width, r.height] };
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    await chrome.waitFor('data?.project?.spec?.length === 24');
    await chrome.click("document.querySelector('[data-tab=spec]')");
    await chrome.click("document.querySelector('#spec-chips [data-rows=\"spec:all\"]')");
    await chrome.waitFor("!!document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    // Approving G1 from the list leaves a note in the list for six seconds; the decline for the next row opens inside that window.
    await chrome.click("document.querySelector('#spec-list [data-row=\"spec:G1\"]')");
    await chrome.stable("document.querySelector('#spec-list').focus();true");
    await pressKey('a', 'KeyA', 65);
    await chrome.waitFor("!!document.querySelector('#spec-list .spec-feedback.ok')");
    await chrome.stable('window.scrollTo(0, document.documentElement.scrollHeight);true');
    await pressKey('d', 'KeyD', 68);
    await chrome.waitFor("!document.querySelector('#spec-decline-dialog').hidden && document.querySelector('#spec-decline-title').textContent === 'Decline G2'");
    assert.equal(await chrome.stable("!!document.querySelector('#spec-list .spec-feedback.ok')"), true, 'the approval note is still in the list when the dialog opens');
    await chrome.send('Input.insertText', { text: 'a reason' });
    const opened = await measure();

    // The note's six-second timer fires while the dialog is open. Its own state clears; the page must not redraw.
    await new Promise((resolve) => setTimeout(resolve, 7000)); // budget: the note's six-second timer, plus a second of slack
    assert.equal(await chrome.stable('view.specFeedback === null'), true, 'the approval note timed out while the dialog was open');
    assert.deepEqual(await measure(), opened, 'nothing moves while the dialog waits for its press');

    // The press itself: record the page and the button at pointer down, then press with the real mouse.
    await chrome.stable("window.__pressAt = null; document.addEventListener('pointerdown', (event) => { if (event.target.closest('#spec-decline-submit')) window.__pressAt = JSON.stringify({ y: scrollY, box: (() => { const r = document.querySelector('#spec-decline-submit').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })() }); }, { capture: true });true");
    await press(chrome, "document.querySelector('#spec-decline-submit')");
    const pressed = JSON.parse(await chrome.stable('window.__pressAt'));
    assert.deepEqual(pressed, opened, 'the page and the submit button are where the person aimed when the press lands');
    assert.deepEqual(chrome.exceptions, []);
  } finally { if (chrome) await closeSnapshotChrome(chrome); rmSync(profile, { recursive: true, force: true }); await view.stop(); }
});
