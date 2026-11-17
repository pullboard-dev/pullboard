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
