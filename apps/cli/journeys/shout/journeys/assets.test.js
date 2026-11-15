/** The view's page and stylesheet arrive compressed and revalidate on a reload [N26]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { serveView } from '../../../src/io/commands/view.js';
import { main as nativeTestMain } from '../../../tests/fixtures/native.js';
import { fetchFresh } from '../../../tests/fixtures/http.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';

test('the view page and stylesheet arrive gzip-encoded and answer a reload with 304 [N26]', async (t) => {
  const home = privateFixtureFiles('pb-asset-').root;
  const previousHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = home;
  const view = await serveView({ port: 0, runCommand: nativeTestMain });
  t.after(async () => {
    try { await view.close(); } finally {
      if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
      else process.env.PULLBOARD_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
  const url = new URL(view.url);
  const get = (path, headers) => fetchFresh(url.origin + path, { headers: { 'x-pullboard-key': url.searchParams.get('k'), ...headers } });
  for (const path of ['/', '/items', '/view.css']) {
    const text = await (await get(path, { 'accept-encoding': 'identity' })).text();
    const zipped = await get(path, { 'accept-encoding': 'gzip' });
    assert.equal(zipped.status, 200);
    assert.equal(zipped.headers.get('content-encoding'), 'gzip', path + ' is gzip-encoded when the request accepts gzip');
    assert.equal(gunzipSync(Buffer.from(await zipped.arrayBuffer())).toString(), text, path + ' decodes to the same bytes');
    const etag = zipped.headers.get('etag');
    assert.match(etag, /^"[\w-]+"$/);
    assert.equal(zipped.headers.get('cache-control'), 'no-cache', path + ' is revalidated, so an upgrade is never stale');
    const again = await get(path, { 'accept-encoding': 'gzip', 'if-none-match': etag });
    assert.equal(again.status, 304, path + ' answers its own ETag with 304');
    assert.equal(await again.text(), '');
    assert.equal((await get(path, { 'accept-encoding': 'gzip', 'if-none-match': '"other"' })).status, 200, path + ' sends the bytes again when the tag differs');
  }
});
