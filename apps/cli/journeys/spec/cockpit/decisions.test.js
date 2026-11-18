// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit real-Chrome row decision check, split from cockpit.test.js [B26,N26,C7]. */
/** @pullboard-world-pin checks by path that the old cockpit.test.js is gone beside this file; no fixture can say that. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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
} from '../../../tests/fixtures/cockpit/harness.js';
import { pressTab } from '../../../tests/fixtures/cockpit/stable.js';
import { watchSpecPress } from '../../../tests/fixtures/cockpit/spec-watch.js';

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
      await box.runIn(demo.repo, 'shout', 'person', `refresh probe ${width}`); // in this process: Chrome is the subject, not the CLI start-up [C7]
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

test('clause 2: cockpit.test.js no longer holds the Spec row decisions case, which lives only in this file [B26,N26,C7]', () => {
  assert.equal(readdirSync(new URL('../', import.meta.url)).includes('cockpit.test.js'), false, 'the emptied cockpit.test.js is gone');
  assert.equal(existsSync(new URL('./decisions.test.js', import.meta.url)), true, 'the case lives here');
});
