/** Hosted and Settings presentation takes plain data; network, filesystem and DOM contracts stay separate [N26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingsMarkup } from '../../../src/logic/settings/render.js';
import { settingsContentHtml } from '../../../src/logic/settings/render.js';
import { starHtml } from '../../../src/logic/render/star.js';
import { hostedMarkup } from '../../../src/logic/hosted/render.js';
import { hostedBrowser } from '../../../src/logic/hosted/render.js';
import { hostedState } from '../../../src/logic/hosted/render.js';

test('Settings preserves value types, selected scope and masked fields from API data [N26,O5,O6,C7]', () => {
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

test('Settings loading, unavailable and empty states cannot display stale row values [N26,O5,O6,C7]', () => {
  const rows = [{ scope: 'machine', key: 'old', value: 'stale value', source: 'machine' }];
  const error = settingsContentHtml({ rows, error: 'Unavailable <detail>' });
  assert.match(error, /role="alert">Unavailable &lt;detail&gt;<\/p>/u);
  assert.doesNotMatch(error, /stale value|data-setting-key/u);
  const loading = settingsContentHtml({ rows, loading: true });
  assert.match(loading, /role="status">Loading settings/u);
  assert.doesNotMatch(loading, /stale value|data-setting-key/u);
  assert.match(settingsContentHtml({ rows: [] }, 'board'), /No settings in this scope/u);
});

test('the star line renders the supplied repository address without reading a manifest [N26,C7]', () => {
  const html = starHtml('https://example.invalid/repo?x="<&');
  assert.match(html, /id="star-line" hidden/u);
  assert.match(html, /href="https:\/\/example\.invalid\/repo\?x=&#34;&#60;&#38;"/u);
  assert.match(html, /Like Pullboard\? A GitHub star helps\./u);
  assert.match(html, /rel="noopener"/u);
  assert.match(html, /id="star-dismiss"/u);
});

test('hosted presentation follows explicit device, pairing and local-board facts [N26,H5,C7]', () => {
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
