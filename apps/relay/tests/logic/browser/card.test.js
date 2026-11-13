/** @pullboard-test-loads apps/relay/src/io/browser/page.js */
/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/dashboard.css apps/view/src/io/item/rows.css apps/view/src/io/stage.css */
/** Check the real public module routes used by the relay browser client [H5,H16]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createRelayBrowserHandler } from '../../../index.js';
import { browserModules } from '../../../index.js';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('the HTTP-served browser module import closure includes the SSE transport asset [H5,H16]', async t => {
  const handler = createRelayBrowserHandler({ authenticate: async () => { throw new Error('public assets must not authenticate'); } });
  const server = createServer(async (request, response) => {
    try {
      if (await handler(request, response)) return;
      response.writeHead(404).end();
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const pending = ['/relay/client.js', '/relay/page-layout.js', '/relay/sealed-pages.js'];
  const seen = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200, path + ' resolves through the real browser asset handler');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/u);
    assert.match(response.headers.get('content-type') ?? '', /javascript/u);
    const source = await response.text();
    for (const match of source.matchAll(/\b(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+(?:\*|\{[^}]*\})\s+from\s*)['"]([^'"]+)['"]/gu)) {
      const specifier = match[1];
      assert.ok(!specifier.startsWith('node:'), 'public browser modules never depend on Node builtins');
      if (!specifier.startsWith('.')) continue;
      const child = new URL(specifier, origin + path).pathname;
      assert.ok(child.startsWith('/relay/'), 'browser module imports remain inside the fixed public asset namespace');
      pending.push(child);
    }
  }
  assert.ok(seen.has('/relay/browser-stream.js'), 'the served client can fetch the SSE transport module it imports');
});


test('the relay stylesheet includes shared stage and item-row rules without unresolved markers [N26,H5]', async t => {
  const handler = createRelayBrowserHandler({ authenticate: async () => { throw new Error('public assets must not authenticate'); } });
  const server = createServer(async (request, response) => { if (!await handler(request, response)) response.writeHead(404).end(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/view.css', { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  const css = await response.text();
  assert.doesNotMatch(css, /@pullboard-[\w-]+-styles/u);
  for (const selector of ['.stage-word', '.item-stage', '.stage-mark', '.roadmap-status', '.row.item-row']) assert.ok(css.includes(selector), selector + ' reaches the relay stylesheet');
});

/** A private repository with a relay entry, a moved body two folders deep and a cell with a pure core.js. */
function moduleTree(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-relay-modules-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(files)) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source); }
  return root;
}

test('a public URL collision cannot replace a real relative package dependency [H5,H16,C7]', t => {
  const root = moduleTree(t, {
    'packages/demo/src/entry.js': "import { value } from './collision.js'; export { value };\n",
    'packages/demo/src/collision.js': "export const value = 'correct';\n",
    'apps/relay/src/io/deploy/other.js': "export const value = 'wrong';\n",
  });
  const served = browserModules(root, { named: {
    '/relay/entry.js': 'packages/demo/src/entry.js', '/relay/collision.js': 'apps/relay/src/io/deploy/other.js',
  } });
  assert.ok(served.has('/relay/m/packages/demo/src/collision.js'), 'the real relative dependency is served');
  assert.match(served.get('/relay/entry.js'), /\.\/m\/packages\/demo\/src\/collision\.js/u);
});

test('a relay file may name a public module that has no file of that name, as a virtual alias [H5,H16,C7]', t => {
  const root = moduleTree(t, {
    'apps/relay/src/io/deploy/browser-entry.js': "import { keys } from './device-keys.js';\nexport const loaded = keys;\n",
    'packages/keys/src/logic/keys.js': "export const keys = 'keys';\n",
  });
  const served = browserModules(root, { named: { '/relay/entry.js': 'apps/relay/src/io/deploy/browser-entry.js', '/relay/device-keys.js': 'packages/keys/src/logic/keys.js' } });
  assert.match(served.get('/relay/entry.js'), /from '\.\/device-keys\.js'/u, 'the alias stays on its public name');
  assert.deepEqual([...served.keys()].sort(), ['/relay/device-keys.js', '/relay/entry.js']);
});

test('the served relay graph keeps each moved package module at its repository path, and it loads [H5,H16,C7]', async t => {
  const root = moduleTree(t, {
    'relay/entry.js': "import { keys } from '../packages/keys/src/core/keys.js';\nimport { flat } from './flat.js';\nexport const loaded = keys + flat;\n",
    'relay/flat.js': "export const flat = 'flat';\n",
    'packages/keys/src/core/keys.js': "import { Refused } from '../../../kernel/index.js';\nexport const keys = Refused.name;\n",
    'packages/kernel/index.js': "import 'node:fs';\nexport * from './core.js';\n",
    'packages/kernel/light.js': "export { Refused } from './src/core/refused.js';\n",
    'packages/kernel/src/core/refused.js': 'export class Refused extends Error {}\n',
  });
  const served = browserModules(root, { named: { '/relay/entry.js': 'relay/entry.js', '/relay/flat.js': 'relay/flat.js', '/relay/refused.js': 'packages/kernel/src/core/refused.js' } });
  assert.deepEqual([...served.keys()].sort(), ['/relay/entry.js', '/relay/flat.js', '/relay/m/packages/kernel/light.js', '/relay/m/packages/keys/src/core/keys.js', '/relay/refused.js']);
  assert.match(served.get('/relay/entry.js'), /from '\.\/m\/packages\/keys\/src\/core\/keys\.js'/u, 'a relay file reaches a moved body by its kept directory path');
  assert.match(served.get('/relay/m/packages/keys/src/core/keys.js'), /from '\.\.\/\.\.\/\.\.\/kernel\/light\.js'/u, 'a front door is read as its pure light.js');
  assert.match(served.get('/relay/m/packages/kernel/light.js'), /from '\.\.\/\.\.\/\.\.\/refused\.js'/u, 'one public refusal module, so instanceof holds across the graph');
  const out = mkdtempSync(join(tmpdir(), 'pullboard-relay-served-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  for (const [url, source] of served) { mkdirSync(dirname(join(out, url)), { recursive: true }); writeFileSync(join(out, url), source); }
  assert.equal((await import(pathToFileURL(join(out, 'relay/entry.js')).href)).loaded, 'Refusedflat');
});

test('a served relay module that reaches a Node builtin or a missing file refuses by name [H5,H16,C7]', t => {
  const root = moduleTree(t, {
    'relay/entry.js': "import { shell } from '../src/shell.js';\nexport const loaded = shell;\n",
    'src/shell.js': "import { readFileSync } from 'node:fs';\nexport const shell = readFileSync;\n",
    'relay/lost.js': "import { gone } from '../src/gone.js';\nexport const lost = gone;\n",
  });
  assert.throws(() => browserModules(root, { named: { '/relay/entry.js': 'relay/entry.js' } }),
    error => error.code === 'RELAY_BROWSER_MODULE' && /src\/shell\.js imports node:fs/u.test(error.message));
  assert.throws(() => browserModules(root, { named: { '/relay/lost.js': 'relay/lost.js' } }),
    error => error.code === 'RELAY_BROWSER_MODULE' && /relay\/lost\.js imports \.\.\/src\/gone\.js/u.test(error.message));
});
