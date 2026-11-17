// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit board-scoped decline and answer checks, split from cockpit.test.js [B26,N26,C7]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  machine,
  project,
  startView,
  boardOf,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';
import { pressTab } from '../../../tests/fixtures/cockpit/stable.js';

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
