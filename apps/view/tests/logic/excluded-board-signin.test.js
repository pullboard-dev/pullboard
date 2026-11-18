/** The view's sign-in names each excluded board and the exact command that relinks it, and says nothing for a board that is not excluded [H5,H17]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayNoticeMarkup } from '../../src/logic/notice.js';

const esc = (value) => String(value).replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);

test('view.x-excluded-board-signin.clause-1-an-excluded-board-is-named: clause 1: an excluded board is named with the exact relay on command that relinks it [H17]', () => {
  const html = relayNoticeMarkup({ cause: 'excluded', machine: 'Tower', name: 'pullboard', by: 'Pat', reason: 'private work' }, esc);
  assert.match(html, /The board pullboard is excluded from sharing by Pat: private work\./u);
  assert.match(html, /Run <code>pullboard relay on --all --only pullboard<\/code>\./u);
  assert.match(html, /role="alert"/u);
});

test('view.x-excluded-board-signin.clause-1-a-board-name-with-a: clause 1: a board name with a quote is shell-quoted so the command still names that one board [H17]', () => {
  const html = relayNoticeMarkup({ cause: 'excluded', machine: 'Tower', name: "Pat's board" }, esc);
  assert.match(html, /<code>pullboard relay on --all --only &#39;Pat&#39;\\&#39;&#39;s board&#39;<\/code>/u);
});

test('view.x-excluded-board-signin.clause-2-a-board-that-is-not: clause 2: a board that is not excluded shows no such line [H17]', () => {
  assert.equal(relayNoticeMarkup(null, esc), '');
  for (const cause of ['asleep', 'relay_off', 'connection']) {
    assert.doesNotMatch(relayNoticeMarkup({ cause, machine: 'Tower', name: 'pullboard' }, esc), /--only|excluded/u);
  }
});
