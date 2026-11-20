/** The footer's offline words: a relay page names the relay and its next step; this machine's view is asked about only when the page reads from it [H5]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { pageScriptPart1 } from '../../index.js';

/** The generated page's own footer function, run alone with the transport the page holds. */
function offlineLine(transport, error) {
  const script = pageScriptPart1({ connection: '{}', hostedOptions: '{}', moduleOption: 'null', pageStartup() {}, paths: {}, privateCost: false, readOnly: false, requestMode: false, snapshot: false, tabValue: '' });
  const from = script.indexOf('function offlineLine(');
  assert.ok(from >= 0, 'the generated page carries its footer function');
  const to = script.indexOf('\n}\n', from) + 3;
  return runInNewContext(script.slice(from, to) + '; offlineLine', { transport })(error);
}

test('view.footer.asks-local-view: clause 1: the footer asks about the local view only when the page reads from it [H5]', () => {
  assert.equal(offlineLine(null, new Error('Failed to fetch')), 'offline: is pullboard view still running?');
});

test('view.footer.names-relay: clause 1: the footer on a relay page names the relay and says one next step per fault, never a raw code [H5,H17]', () => {
  const transport = {};
  const wait = 'offline: the relay is not answering. Wait a moment; this page tries again by itself.';
  const reload = 'offline: this page is older than the relay. Reload this page to get the new version.';
  assert.equal(offlineLine(transport, new TypeError('Failed to fetch')), wait, 'relay down');
  assert.equal(offlineLine(transport, new Error('network error')), wait, 'relay slow or cut off');
  assert.equal(offlineLine(transport, Object.assign(new Error('The relay did not answer.'), { code: 'RELAY_UNAVAILABLE' })), wait, 'relay failing with 503');
  assert.equal(offlineLine(transport, { code: 'SNAPSHOT_REQUIRED', message: 'fetch the latest sealed state' }), wait, 'relay catching up');
  assert.equal(offlineLine(transport, Object.assign(new Error('Upgrade this browser client.'), { code: 'ENGINE_VERSION' })), reload, 'stale engine');
  assert.equal(offlineLine(transport, new Error('[ENGINE_VERSION] upgrade the browser client')), reload, 'stale engine in a bracketed message');
  for (const line of [wait, reload]) assert.doesNotMatch(line, /pullboard view|\[[A-Z_]+\]|Failed to fetch/u);
});
