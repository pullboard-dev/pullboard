/** Relay off keeps the retained relay copy, and every real CLI request declares its engine [H1,H18,H16,H3]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import { relayClientFixture } from '../../../tests/fixtures/relay/client.js';
import { assertPersonUnlinkHistory } from '../../../tests/fixtures/relay/exclusion.js';

test('plain relay off explains the retained relay copy without printing credentials [H1,H18]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const localBeforeOff = (await box.cliLocal('export')).document.tables;
  const callsBeforeOff = box.calls.length;
  const result = await box.script(`
    import { main } from ${JSON.stringify(box.mainURL)};
    let output = '';
    const code = await main(['relay', 'off'], {
      cwd: process.cwd(), stdout: { write(part) { output += part; } }, stderr: { write() {} },
    });
    console.log(JSON.stringify({ code,
      retained: output.includes('relay copy stays until you approve deleting it on your phone'),
      credential: /(?:ps|pm|pa|pg)_[A-Za-z0-9_-]{43}|key=/u.test(output) }));
  `);
  assert.equal(result.code, 0);
  assert.deepEqual(result.document, { code: 0, retained: true, credential: false });
  assert.equal(existsSync(box.linkFile), false, 'plain local off removes the device link');
  assert.equal(existsSync(box.keyFile), false, 'plain local off forgets the device key');
  assert.ok(JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'relay-machine/state.json'), 'utf8')).excluded.includes(box.root));
  assertPersonUnlinkHistory((await box.cliLocal('export')).document.tables, localBeforeOff);
  assert.equal(box.calls.slice(callsBeforeOff).some(call => call.method === 'DELETE'),
  false,
    'plain local off never deletes the remote copy without phone approval');
});


test('every real CLI relay request declares its engine including sign-in, reads, writes and unlink [H16,H3]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  assert.equal((await box.cliLocal('export')).code, 0);
  assert.equal((await box.cliLocal('add', box.lane, 'Declared-engine fixture move')).code, 0);
  const off = await box.cliLocal('relay', 'off');
  assert.equal(off.code, 0);
  assert.match(off.document.notice, /relay copy stays until you approve deleting it on your phone/u);
  assert.ok(box.calls.some(call => call.path.startsWith('/auth/')));
  assert.ok(box.calls.some(call => call.method === 'GET' && call.path.includes('/events')));
  assert.ok(box.calls.some(call => call.method === 'POST' && call.path.endsWith('/moves')));
  assert.ok(box.calls.some(call => call.method === 'POST' && /^\/api\/v2\/boards\/[0-9a-f]{32}\/uploads\/[^/]+\/publish$/u.test(call.path)), 'the current CLI publishes an authenticated paged checkpoint');
  assert.equal(box.calls.some(call => call.method === 'DELETE'), false, 'local off does not send remote deletion without phone approval');
  assert.ok(box.calls.every(call => call.engine === String(ENGINE_VERSION)), 'every request from the real CLI carries the current engine version');
});

