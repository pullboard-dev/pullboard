/** Hosted and Settings presentation takes plain data; network, filesystem and DOM contracts stay separate [N26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingsMarkup } from '../../../src/logic/settings/render.js';
import { settingsContentHtml } from '../../../src/logic/settings/render.js';
import { starHtml } from '../../../src/logic/render/star.js';
import { hostedMarkup } from '../../../src/logic/hosted/render.js';
import { hostedBrowser } from '../../../src/logic/hosted/render.js';
import { hostedState } from '../../../src/logic/hosted/render.js';

test('view.hosted-render.settings-preserves-value-types-selected-scope-and: Settings preserves value types, selected scope and masked fields from API data [N26,O5,O6,C7]', () => {
  const rows = [false, 0, '', null, { nested: '<data>' }].map((value, index) => ({ scope: 'machine', key: 'key' + index, value, default: null, source: 'machine' }));
  rows.push({ scope: 'board', key: 'other board', value: 'outside selected scope', default: null, source: 'board' },
    { scope: 'machine', key: 'masked', secret: true, value: 'private fixture value', default: 'private default', source: 'file', origin: '<origin>' });
  const entry = { context: 'Computer <name>', rows }, before = JSON.stringify(entry);
  const html = settingsContentHtml(entry, 'machine');
  assert.match(html, /data-setting-key="key0"[^]*?<b title="false">off<\/b>/u);
  assert.match(html, /data-setting-key="key1"[^]*?<b title="0">0<\/b>/u);
  assert.match(html, /data-setting-key="key2"[^]*?<b title="">empty<\/b>/u);
  assert.match(html, /data-setting-key="key3"[^]*?<b title="">none<\/b>/u);
  assert.match(html, /&quot;nested&quot;:&quot;&lt;data&gt;&quot;/u);
  assert.match(html, /data-settings-scope="machine" aria-selected="true"/u);
  assert.match(html, /data-setting-key="masked"[^]*?<b title="not set">not set<\/b>/u);
  assert.doesNotMatch(html, /outside selected scope|private fixture value|private default/u);
  assert.equal(JSON.stringify(entry), before);
  assert.match(settingsContentHtml(entry, 'board'), /outside selected scope/u);
  assert.match(settingsMarkup(), /data-pane="settings"[^]*?hidden/u);
});

test('view.hosted-render.settings-loading-unavailable-and-empty-states-cannot: Settings loading, unavailable and empty states cannot display stale row values [N26,O5,O6,C7]', () => {
  const rows = [{ scope: 'machine', key: 'old', value: 'stale value', source: 'machine' }];
  const error = settingsContentHtml({ rows, error: 'Unavailable <detail>' });
  assert.match(error, /role="alert">Unavailable &lt;detail&gt;<\/p>/u);
  assert.doesNotMatch(error, /stale value|data-setting-key/u);
  const loading = settingsContentHtml({ rows, loading: true });
  assert.match(loading, /role="status">Loading settings/u);
  assert.doesNotMatch(loading, /stale value|data-setting-key/u);
  assert.match(settingsContentHtml({ rows: [] }, 'board'), /No settings in this scope/u);
});

test('view.hosted-render.clause-1-settings-shows-a-refused-inventory: clause 1: Settings shows a refused inventory as a plain-words problem that names the setting [N26,O5,O6,C7]', () => {
  const raw = '[BAD_SETTINGS] setting gate.timingRunner has an unsupported type; restore its documented value';
  const html = settingsContentHtml({ error: raw });
  assert.match(html, /role="alert">gate\.timingRunner holds the wrong kind of value\. Set it back to its documented value, then choose Refresh\.<\/p>/u);
  assert.doesNotMatch(html, /BAD_SETTINGS|unsupported type/u);
  assert.match(html, /class="settings-head"/u);
  assert.match(html, /data-settings-scope="board"/u);
});

test('view.hosted-render.clause-2-settings-draws-every-other-setting: clause 2: Settings draws every other setting beside the one with a problem [N26,O5,O6,C7]', () => {
  const bad = { scope: 'machine', key: 'gate.runnersOnly', label: 'Runners only', value: null, default: false, source: 'file', description: 'x', error: { message: 'Runners only (gate.runnersOnly) holds the wrong kind of value.', fix: 'Set gate.runnersOnly back to false.' } };
  const good = { scope: 'machine', key: 'gateSlots', label: 'Slots', value: 2, default: 2, source: 'file', description: 'y' };
  const rows = settingsContentHtml({ rows: [bad, good] }, 'machine');
  assert.match(rows, /data-setting-key="gate\.runnersOnly"[^]*?setting-error[^]*?holds the wrong kind of value/u);
  assert.match(rows, /data-setting-key="gateSlots"/u);
});

test('view.hosted-render.clause-1-settings-drops-the-machine-s: clause 1: Settings drops the machine\'s internal resource rows and keeps grouped cards with their changed counts [N26,O5,O6,C7]', () => {
  const row = (key, extra = {}) => ({ scope: 'machine', key, label: key, description: 'd', group: 'Capacity', unit: 'count', value: 3, default: 1, source: '/x/settings.json', ...extra });
  const rows = [row('gateSlots', { cli: 'gateSlots' }), row('resources.test-file-loan:abc123.capacity'), row('resources.submit-handoff-workers.capacity'), row('resources.runner:mini-4.capacity'), row('resources.custom.capacity'), row('gate.queue.reviewsFirst', { group: 'Order', value: true, default: false })];
  const html = settingsContentHtml({ rows }, 'machine');
  assert.doesNotMatch(html, /test-file-loan|submit-handoff|runner:mini/u, 'internal resource rows never appear');
  assert.match(html, /data-setting-key="resources\.custom\.capacity"/u, 'a resource a person set still shows');
  assert.match(html, /<h2 class="hd1">Capacity<\/h2>[^]*?2 changed[^]*?<h2 class="hd1">Order<\/h2>[^]*?1 changed/u, 'each group is a card with its changed count');
});

test('view.hosted-render.clause-2-every-changed-row-with-a: clause 2: every changed row with a command has a copy button, and name, key and description each sit on one line [N26,O5,O6,C7]', () => {
  const base = { scope: 'machine', label: 'Scratch folder', description: 'A long sentence.', group: 'Capacity', unit: 'text', source: '/x/settings.json' };
  const html = settingsContentHtml({ rows: [{ ...base, key: 'scratch', cli: 'scratch', value: '/tmp/my scratch', default: '/tmp/scratch' }, { ...base, key: 'gateSlots', cli: 'gateSlots', value: 4, default: 2 }] }, 'machine');
  assert.match(html, /data-copy-command="pullboard settings scratch &#39;\/tmp\/my scratch&#39;"/u, 'a text value is quoted for the shell');
  assert.match(html, /data-copy-command="pullboard settings gateSlots 4"/u);
  assert.equal((html.match(/class="set-title"/gu) || []).length, 2, 'name and key share one title line');
});

test('view.hosted-render.the-star-line-renders-the-supplied-repository: the star line renders the supplied repository address without reading a manifest [N26,C7]', () => {
  const html = starHtml('https://example.invalid/repo?x="<&');
  assert.match(html, /id="star-line" hidden/u);
  assert.match(html, /href="https:\/\/example\.invalid\/repo\?x=&#34;&#60;&#38;"/u);
  assert.match(html, /Like Pullboard\? A GitHub star helps\./u);
  assert.match(html, /rel="noopener"/u);
  assert.match(html, /id="star-dismiss"/u);
});

test('view.hosted-render.hosted-presentation-follows-explicit-device-pairing-and: hosted presentation follows explicit device, pairing and local-board facts [N26,H5,C7]', () => {
  assert.equal(hostedBrowser({ userAgent: 'Mozilla Firefox/1' }), 'Firefox');
  assert.equal(hostedBrowser({ userAgentData: { brands: [{ brand: 'Chromium' }] } }), 'Chrome');
  const phone = hostedState('signed-out', { phone: true });
  assert.equal(phone.heading, 'Your boards, on your phone');
  assert.deepEqual(phone.parts, ['github']);
  const local = hostedState('local-open', { listed: true, signedIn: true, localOriginKnown: true });
  assert.equal(local.kind, 'note');
  assert.deepEqual(local.parts, ['local-open']);
  const unpaired = hostedState('unpaired', { linked: ['Fixture board'] });
  assert.match(unpaired.text, /open the link it prints here or scan its QR/u);
  assert.match(unpaired.small, /Fixture board/u);
  assert.equal(hostedState(null), null);
  const html = hostedMarkup('http://localhost:1234', { looking: true, signIn: '/sign-in' });
  assert.match(html, /data-state="looking"/u);
  assert.match(html, /Finding your boards/u);
  assert.match(html, /href="http:\/\/localhost:1234\/local\/view"/u);
  assert.match(html, /href="\/sign-in"/u);
});
