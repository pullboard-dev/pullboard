// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit spec checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  tapTarget,
  machine,
  project,
  startView,
  boardOf,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  watchSpecDecisionWait,
  press,
} from '../../tests/fixtures/cockpit/harness.js';
import { pressTab } from '../../tests/fixtures/cockpit/stable.js';
import { watchSpecPress } from '../../tests/fixtures/cockpit/spec-watch.js';

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
    await pressTab(chrome, `${kind}`); await chrome.click(`document.querySelector('#${kind}-chips [data-rows="${kind}:${name}"]')`);
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
          assert.deepEqual(r.section, [], `${tab}: ${kind} rows are decided one at a time; no group Approve all`);

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
          // The two decided rows leave Rulings.
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
      await pressTab(chrome, 'spec');
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
      assert.equal(await chrome.stable("document.querySelector('#spec-chips [data-rows=\"spec:decide\"] b').textContent"), '30', `${width}: Rulings excludes the decided row`);
      if (width === 1280) assert.ok(await chrome.stable(`(() => {
        const row=document.querySelector('#spec-list [data-row="spec:G1"]');
        const chip=row.querySelector('.spec-row-side .chip').getBoundingClientRect();
        const words=[...row.querySelector('.srow-text').childNodes].find(n=>n.nodeType===3&&n.textContent.trim());
        const range=document.createRange(); range.selectNodeContents(words); const text=range.getClientRects()[0];
        return chip.right <= text.left || chip.left >= text.right || chip.bottom <= text.top || chip.top >= text.bottom;
      })()`), '1280: the approved row tier does not cover row text');

      await chrome.click("document.querySelector('#spec-chips [data-rows=\"spec:decide\"]')");
      assert.equal(await chrome.stable("!!document.querySelector('#spec-list [data-row=\"spec:G1\"]')"), false, `${width}: approval immediately leaves Rulings`);
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
      for (const id of ['K1', 'K2']) {
        await click(chrome, '#spec-list [data-row="spec:' + id + '"]');
        await chrome.waitFor(`view.row.spec === '${id}' && !!document.querySelector('#spec-detail [data-row-decision=approve]')`);
        await click(chrome, '#spec-detail [data-row-decision="approve"]');
        await chrome.waitFor(`data.project.spec.find(row => row.id === '${id}')?.stage === 'approved, pending apply'`);
      }
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
      assert.ok(await chrome.stable("document.querySelector('#spec-chips [data-rows=\"spec:decide\"]').innerText.includes('27')"), `${width}: Rulings excludes all four decided rows`);
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
