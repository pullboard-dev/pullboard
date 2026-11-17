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
    await pressTab(chrome, 'spec');
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
    await pressTab(chrome, 'spec');
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
    await pressTab(chrome, 'spec');
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
