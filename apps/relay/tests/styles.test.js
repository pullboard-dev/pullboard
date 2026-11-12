/** @pullboard-test-input apps/relay/src/io/browser/page.js */
/** @pullboard-test-loads apps/relay/src/io/browser/page.js */
/** The relay browser page serves the view's composed stylesheet [C7,#3202]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRelayBrowserHandler } from '../index.js';
import { composeViewStyles } from '../../view/index.js';

async function serveCss(t) {
  const handler = createRelayBrowserHandler({ authenticate: async () => { throw new Error('public assets must not authenticate'); } });
  const server = createServer(async (request, response) => {
    if (await handler(request, response)) return;
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(done => server.close(done)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/view.css');
  return response.text();
}

test('clause 1: browser-page.js builds its stylesheet with composeViewStyles and no longer fills the markers itself [C7,#3202]', () => {
  const source = readFileSync(new URL('../src/io/browser/page.js', import.meta.url), 'utf8');
  assert.match(source, /composeViewStyles\(\)/u);
  assert.doesNotMatch(source, /@pullboard-[\w-]+-styles/u);
});

test('clause 2: the relay /view.css serves the composed stylesheet, with no marker left [C7,#3202]', async t => {
  const css = await serveCss(t);
  assert.ok(css.startsWith(composeViewStyles()), 'the composed view stylesheet leads the served css');
  assert.doesNotMatch(css, /@pullboard-[\w-]+-styles/u);
});
