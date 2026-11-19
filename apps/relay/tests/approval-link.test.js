// pullboard: browser
/** @pullboard-test-gui */
/** An approved link opens on the phone from one relay on --all run, which this test calls in process [H17,E16,C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { relayDirectFixture } from './fixtures/relay-direct-fixture.js';
import {
  pairChromePhone,
  waitFor,
} from './fixtures/relay-phone-fixture.js';
import { autoLinkProject } from '../../../packages/link/index.js';
import { readRelayMachine } from '../../../packages/link/index.js';
import { relayOnAll } from '../../../packages/link/index.js';
import { registerProject } from '../../../packages/seats/index.js';
import { closeCellBoard } from '../../../packages/board/tests/fixtures/cell-board.js';
import { CELL_CONFIG } from '../../../packages/store/tests/fixtures/cell.js';
import { cellItem } from '../../../packages/store/tests/fixtures/cell.js';
import { cellRepo } from '../../../packages/store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../packages/board/tests/fixtures/cell-board.js';
import { pressTab } from '../../cli/tests/fixtures/cockpit/stable.js';
import { runFixtureGit } from '../../cli/tests/fixtures/child.js';
import { findChromeExecutable } from '../../cli/tests/fixtures/relay/browser.js';

/** The first board's own item, which the phone must not leave on screen once it selects the approved board. */
const FIRST_TITLE = 'private cleanup fixture item';

/** Add one item to a project's board the way a person's add does, through the store door. */
function addItemTo(boardFile, title) {
  const board = openCellBoard(boardFile);
  try { cellItem(board, { lane: 'web', title }); } finally { closeCellBoard(board); }
}

/**
 * Walkthrough-090 issue 15: a paired phone, a new board "notes" whose link card waits on it, relay on --all running, one tap.
 * The snapshot upload is held until the phone has rendered its notice, so the phone is observed before its key arrives.
 */
async function approvedLinkScenario(t) {
  const box = await relayDirectFixture(t, { openCellBoard, closeCellBoard });
  addItemTo(box.boardFile, FIRST_TITLE);
  const { chrome } = await pairChromePhone(box, t);
  box.server.providerState.repositories.push('notes');
  const notes = cellRepo(t, { config: { ...CELL_CONFIG, name: 'notes' } });
  runFixtureGit(['remote', 'add', 'origin', 'git@github.com:fixture/notes.git'], { cwd: notes.root, env: process.env });
  const notesTitle = 'an item only on the newly approved notes board';
  addItemTo(notes.boardFile, notesTitle);
  // The project registers and offers its link to the phone the way init does.
  registerProject(notes.root);
  await autoLinkProject(notes.root, box.io, { openBoard: box.io.openBoard });
  const proposal = readRelayMachine().approvals.find(entry => entry.root === notes.root);
  assert.ok(proposal?.published, 'registering publishes one sealed link card for notes');
  const board = proposal.context.board;
  const button = '#phone-approve-' + proposal.context.id;
  await chrome.waitFor(`document.querySelector(${JSON.stringify(button)}) !== null`);

  const said = [];
  const complained = [];
  const io = { ...box.io, say: line => said.push(String(line)), err: line => complained.push(String(line)) };
  const run = relayOnAll(box.origin, io);
  let outcome = null;
  run.then(result => { outcome = { result }; }, error => { outcome = { error }; });
  await waitFor(() => said.some(line => line.startsWith('waiting for phone approval: notes')) || outcome,
    'relay on --all reaches its wait for the phone or ends');
  const waited = said.some(line => line.startsWith('waiting for phone approval: notes'));
  if (!waited) {
    const early = await run.catch(error => ({ failed: [error] }));
    return { waited, said, complained, code: early.failed?.length ? 1 : 0 };
  }

  await chrome.stable(`(() => {
    const notice = document.querySelector('#relay-notice');
    window.__noticeLog = [notice?.textContent ?? ''];
    new MutationObserver(() => window.__noticeLog.push(notice.textContent))
      .observe(notice, { childList: true, subtree: true, characterData: true });
  })()`);
  let held = false;
  let release;
  const released = new Promise(resolveRelease => { release = resolveRelease; });
  box.server.beforeNextSnapshot(async () => { held = true; await released; });
  await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await pressTab(chrome, 'shouts');
  await chrome.waitFor(`view.tab === "shouts" && document.querySelector('[data-pane="items"]').hidden`);
  const documentOrigin = await chrome.stable('performance.timeOrigin');
  const authorizeBefore = box.server.calls.filter(call => call.path.endsWith('/authorize')).length;
  await chrome.click(`document.querySelector(${JSON.stringify(button)})`);
  await waitFor(() => held, 'the computer starts linking notes in the same run once the phone approves');
  let noticeBeforeKey = null;
  try {
    await chrome.waitFor(`(document.querySelector('#relay-notice')?.textContent ?? '').includes(${JSON.stringify(board.slice(0, 8))})
      || (document.querySelector('#relay-notice')?.textContent ?? '').includes('pair this browser')`);
    noticeBeforeKey = await chrome.stable(`document.querySelector('#relay-notice').textContent`);
  } finally { release(); }
  const finished = await run.catch(error => ({ failed: [error], linked: [] }));
  const linkedAtExit = existsSync(join(notes.root, '.git/pullboard/relay.json'));
  let opened = true;
  try {
    await chrome.waitFor(`document.querySelectorAll('#proj-list .proj.repo').length === 2
      && Object.hasOwn(JSON.parse(localStorage.getItem('pullboard.relay.keys.v1') ?? '{}'), ${JSON.stringify(board)})`);
  } catch { opened = false; }
  try { /* budget: hang ceiling for the bounded navigation transition the mobile counter observes; no approval retry. */ await chrome.waitFor(`data?.root === ${JSON.stringify(board)} && document.querySelector('#proj-name')?.textContent === 'notes'
    && document.body.innerText.includes(${JSON.stringify(notesTitle)})`, 6_000); } catch { /* The assertion below names a missed selection directly. */ }
  const displayed = await chrome.stable(`({ root: data?.root, name: document.querySelector('#proj-name')?.textContent,
    text: document.body.innerText })`);
  const visibleItems = [];
  for (const width of [390, 1280]) {
    await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
    visibleItems.push(await chrome.stable(`(() => {
      const pane = document.querySelector('[data-pane="items"]');
      const row = [...document.querySelectorAll('#chain [data-item]')].find(node => node.textContent.includes(${JSON.stringify(notesTitle)}));
      const rect = row?.getBoundingClientRect();
      return { width: innerWidth, tab: view.tab, visible: !pane.hidden && Boolean(rect && row.getClientRects().length && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0) };
    })()`));
  }
  const sameDocument = await chrome.stable('performance.timeOrigin') === documentOrigin;
  return {
    waited, code: finished.failed.length ? 1 : 0, said, complained, linkedAtExit, opened, noticeBeforeKey,
    noticeLog: await chrome.stable('window.__noticeLog'), targetBoard: board, notesTitle, displayed, visibleItems, sameDocument,
    taps: box.server.calls.filter(call => call.path.endsWith('/authorize')).length - authorizeBefore,
  };
}

test('relay.approval-link.an-approved-link-opens-on-the: an approved link opens on the phone without another command [H17,E16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const run = await approvedLinkScenario(t);
  assert.equal(run.waited, true, `relay on --all waits for the phone's link card: ${run.said.join('\n')}`);
  assert.equal(run.taps, 1, 'one phone tap authorizes the link');
  assert.equal(run.code, 0, `the waiting run finishes cleanly: ${run.complained.join('\n')}`);
  assert.equal(run.linkedAtExit, true, 'the same run links notes; no later command is needed');
  assert.equal(run.opened, true, 'the phone unwraps the notes key and lists the board with no other command');
  assert.equal(run.displayed.root, run.targetBoard, 'the phone selects the newly approved board, rather than only listing it');
  assert.equal(run.displayed.name, 'notes', 'the visible project heading names the approved notes board');
  assert.ok(run.displayed.text.includes(run.notesTitle), "the approved board's own item is visible");
  assert.equal(run.sameDocument, true, 'approval keeps the same browser document');
  for (const result of run.visibleItems) {
    assert.equal(result.tab, 'items', `${result.width}px approval opens Items after Shouts`);
    assert.equal(result.visible, true, `${result.width}px approved item is visible on screen`);
  }
  assert.equal(run.displayed.text.includes(FIRST_TITLE), false, "the previously open board's item is not left on screen");
  assert.match(run.noticeBeforeKey, /approved; waiting for the computer to send this phone its key\./u,
    'before the key arrives the phone says it is on the way');
  assert.equal(run.noticeLog.some(text => text.includes('pair this browser')), false,
    `the phone that approved is never told to pair again: ${JSON.stringify(run.noticeLog)}`);
});
