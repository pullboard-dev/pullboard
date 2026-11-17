/** The page's relay-client load failure names its real relay cause, and a plain failure keeps the network wording [C7,#9457]. */
/** @pullboard-test-input source-cell apps/view */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageScriptPart4 } from '../../src/io/page/actions.js';
import { relayCauseMessage } from '../../src/logic/relay-cause.js';
import { startupFailureLine } from '../../src/logic/relay-cause.js';

/** The page's own loadTransport, cut from the script the page serves, so the test runs the production path. */
function loadTransportWith(failure) {
  const script = pageScriptPart4({ startupFailureLine, relayCauseMessage });
  const start = script.indexOf('async function loadTransport()');
  const end = script.indexOf('\n}\n', start) + 2;
  const said = [];
  const module = `data:text/javascript,${encodeURIComponent('export function createTransport() { throw globalThis.__relayFailure; }')}`;
  globalThis.__relayFailure = failure;
  const pageStartup = () => ({ say: (line) => said.push(line), within: (work) => work() });
  const run = new Function('pageStartup', 'document', 'configuredTransportModule', `let transport = null, transportModule = null, transportLoadError = null; ${script.slice(start, end)}; return loadTransport;`);
  return { said, load: run(pageStartup, { documentElement: {} }, module) };
}

test('clause 1: a load failure carrying relay_off or excluded shows that cause in the startup line [C7,#9457]', async () => {
  for (const cause of [{ cause: 'relay_off', machine: 'Tower' }, { cause: 'excluded', machine: 'Tower', name: 'main-board', by: 'Pat' }]) {
    const failure = Object.assign(new Error('The relay did not answer.'), { relayCause: cause });
    const { said, load } = loadTransportWith(failure);
    await assert.rejects(load(), failure);
    assert.equal(said.length, 1);
    assert.ok(said[0].startsWith(relayCauseMessage(cause).message), `the line says ${cause.cause}: ${said[0]}`);
    assert.doesNotMatch(said[0], /Check your connection/u);
  }
});

test('clause 2: a load failure with no relayCause still reads as Check your connection [C7,#9457]', async () => {
  const failure = new Error('The relay client did not load within 15 seconds.');
  const { said, load } = loadTransportWith(failure);
  await assert.rejects(load(), failure);
  assert.equal(said[0], 'The relay client did not load within 15 seconds. Check your connection, then reload this page.');
  assert.match(startupFailureLine(Object.assign(new Error('x'), { relayCause: { cause: 'offline' } }), relayCauseMessage), /Check your connection/u);
});
