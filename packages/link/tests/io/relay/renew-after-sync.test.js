/** @pullboard-test-input source-cell link */
/** After a good sync a linked machine renews its credential once and keeps the new expiry; a failed renewal never fails the sync [H5,H16,#9330]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { renewAfterSync } from '../../../index.js';

const TOKEN = 'pm_' + 'a'.repeat(43);
const DAY = 86_400_000;

/** A loopback relay that answers the renew route as `reply` says and counts the calls it gets. */
async function relay(reply) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const [status, body] = reply();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: 1, ...body }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}

/** A saved link for one machine on a board, and the io a sync hands in. */
function linked(url, { enabled = true } = {}) {
  const files = privateFixtureFiles('pullboard-renew-');
  const state = { url, board: 'b1', token: TOKEN, tokenId: 'cred1', machine: 'm1', tokenExpires: 1000 };
  const output = [];
  return { file: join(files.root, 'link.json'), state, output, io: { renewAfterSync: enabled, err: (line) => output.push(line), ignoreRelayEnvironmentToken: true } };
}
const renewed = (over = {}) => () => [200, { id: 'cred1', kind: 'machine', board: 'b1', machine: 'm1', created: 5, renewedAt: 2_000, expires: 2_000 + 30 * DAY, ...over }];

test('clause 1: a successful sync calls the relay renew route once and stores the new expiry on the link [H5,#9330]', async () => {
  const server = await relay(renewed());
  const { file, state, output, io } = linked(server.url);
  try { await renewAfterSync(file, state, io); } finally { await server.close(); }
  assert.deepEqual(server.calls, ['POST /auth/credentials/renew']);
  assert.equal(state.tokenExpires, 2_000 + 30 * DAY);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).tokenExpires, 2_000 + 30 * DAY, 'the saved link holds the new expiry');
  assert.deepEqual(output, []);
});

test('clause 1: a refused or invalid renewal never fails the sync and never prints pending uploads [H16,#9330]', async () => {
  for (const [why, reply] of [['a refusal', () => [503, { error: { code: 'FIXTURE_REFUSAL', message: 'controlled' } }]],
    ['another machine\'s reply', renewed({ machine: 'other' })], ['a reply that does not extend', renewed({ expires: 1_000 })]]) {
    const server = await relay(reply);
    const { file, state, output, io } = linked(server.url);
    try { await renewAfterSync(file, state, io); } finally { await server.close(); }
    assert.equal(state.tokenExpires, 1000, `${why}: the old expiry stays`);
    assert.equal(output.length, 1, why);
    assert.doesNotMatch(output[0], /pending uploads/u, why);
    assert.doesNotMatch(output[0], /pm_/u, `${why}: no bearer value is printed`);
  }
});

test('clause 1: with relay.renewAfterSync off, or an older relay without the route, the sync stays as it was [C7,#9330]', async () => {
  const off = await relay(renewed());
  const a = linked(off.url, { enabled: false });
  try { await renewAfterSync(a.file, a.state, a.io); } finally { await off.close(); }
  assert.deepEqual(off.calls, [], 'the route is not called');
  const old = await relay(() => [404, { error: { code: 'NOT_FOUND', message: 'no route' } }]);
  const b = linked(old.url);
  try { await renewAfterSync(b.file, b.state, b.io); } finally { await old.close(); }
  assert.deepEqual(b.output, [], 'an older relay is quiet');
});
