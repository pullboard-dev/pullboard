/** A sleeping or offline machine reads as asleep with its name, no error look, and the note goes away on waking [H5,N26,#9458]. */
/** @pullboard-test-input source-cell apps/view */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayNoticeMarkup } from '../../src/logic/notice.js';
import { relayCauseMessage } from '../../src/logic/relay-cause.js';
import { relayNoticeView } from '../../src/logic/relay-cause.js';

const esc = (value) => String(value).replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);

test('clause 1: an asleep status names the machine in asleep wording with no error role [H5]', () => {
  const html = relayNoticeMarkup({ cause: 'asleep', machine: 'm1', label: 'Tower' }, esc);
  assert.match(html, /Tower is asleep/u);
  assert.match(html, /data-tone="asleep"/u);
  assert.doesNotMatch(html, /role="alert"|error|check your connection/iu);
  assert.match(html, /catch up when it wakes/u);
});

test('clause 1: an offline status reads the same as asleep [H5]', () => {
  assert.deepEqual(relayCauseMessage({ cause: 'offline', label: 'Tower' }), relayCauseMessage({ cause: 'asleep', label: 'Tower' }));
  assert.equal(relayNoticeView({ cause: 'offline', machine: 'Tower' }).tone, 'asleep');
  assert.match(relayNoticeMarkup({ cause: 'offline', machine: 'Tower' }, esc), /Tower is asleep/u);
});

test('clause 1: after the machine wakes the note is gone and a real trouble still shows as an error [H5]', () => {
  assert.equal(relayNoticeMarkup(null, esc), '');
  assert.equal(relayNoticeView(null), null);
  const trouble = relayNoticeMarkup({ cause: 'relay_off', machine: 'Tower' }, esc);
  assert.match(trouble, /role="alert"/u);
  assert.match(trouble, /pullboard relay on/u);
});

test('clause 1: a machine with no name falls back to that computer [H5]', () => {
  assert.match(relayNoticeMarkup({ cause: 'asleep' }, esc), /That computer is asleep/u);
});
