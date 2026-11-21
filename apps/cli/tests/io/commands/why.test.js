/** @pullboard-test-input apps/cli/src/io/commands/why.js apps/cli/src/io/commands/view.js apps/cli/tests/fixtures/next/take.js */
/** The view command hands the home page the Flow reader that `pullboard why` builds from the board [N26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../../fixtures/native.js';
import { fixture } from '../../fixtures/next/take.js';
import { fetchPrintedViewLink } from '../../fixtures/view/link.js';
import * as nativeBoard from '../../../lib/index.js';
import { registerProject } from '../../../../../packages/seats/index.js';
import { flowReader } from '../../../src/io/commands/why.js';

test('cli.io-commands-why.flow-reader: clause 1: flowReader(io) returns the releaseFlow document and returns null on a board read error [N26,C7]', async t => {
  const box = await fixture(t);
  const doc = flowReader({ cwd: box.root, clock: box.clock, nativeBoard })();
  assert.ok(doc && Array.isArray(doc.items) && Array.isArray(doc.idle), 'the reader returns the flow document');
  assert.equal(flowReader({ cwd: '/nonexistent-pullboard-flow-reader', nativeBoard })(), null, 'a board that cannot be read gives null, not a throw');
});

test('cli.io-commands-why.view-passes-flow-reader: clause 2: the real view command serves a home page that shows the Flow panel because view.js passes readFlow from flowReader [N26,C7]', { timeout: 120_000 }, async t => {
  const box = await fixture(t);
  registerProject(box.root);
  process.env.PULLBOARD_VIEW_FOREGROUND = '1';
  let out = '';
  let pending;
  const link = await new Promise((found, fail) => {
    pending = main(['view', '--project', '--no-open', '--port', '0', '--json'], { cwd: box.root, stdin: process.stdin,
      stdout: { isTTY: false, write: part => {
        out += part;
        try { found(new URL(JSON.parse(out).url)); } catch { /* the one JSON document is not complete yet */ }
        return true;
      } }, stderr: { isTTY: false, write: () => true } }).then(code => fail(new Error(`view exited early with code ${code}`)));
  });
  t.after(async () => { process.emit('SIGTERM'); await pending; delete process.env.PULLBOARD_VIEW_FOREGROUND; });
  const page = await (await fetchPrintedViewLink(link)).text();
  assert.match(page, /<div class="sx-card sx-flow">/u, 'the served home page carries the Flow panel');
});
