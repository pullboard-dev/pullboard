/** A linked board whose baseline is paused never makes a command wait on a relay that does not answer [R6,C7]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

const RETURN_MS = 500; // budget: the R6 bar, one command with a silent relay.

test('with the relay not answering, a command on a paused-baseline board returns in under 500 ms and names the wait [R6,C7]', async t => {
  const box = await relayClientFixture(t, { accountStorageBytes: 1000 }); // Too small for any baseline, so the upload pauses on the account limit.
  await box.link();
  const saved = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.ok(saved.baselinePause, 'the baseline upload is paused');
  // A relay that accepts the connection and never answers: the case that waited 10 s per request.
  const sockets = new Set();
  const silent = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); });
  await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); silent.close(); });
  writeFileSync(box.linkFile, JSON.stringify({ ...saved, url: `http://127.0.0.1:${silent.address().port}` }), { mode: 0o600 });
  for (const args of [['list'], ['status']]) {
    const started = performance.now();
    const result = await box.cliLocal(...args);
    const elapsed = performance.now() - started;
    assert.equal(result.code, 0, `${args[0]} still reads the local board`);
    assert.ok(elapsed < RETURN_MS, `${args[0]} returned in ${Math.round(elapsed)} ms`); // budget: declared bar of #7779, a silent relay costs a command under 500 ms.
    assert.match((result.document.diagnostics ?? []).join('\n'), /baseline upload is paused.*waits for the relay/u, `${args[0]} names the wait`);
  }
});
