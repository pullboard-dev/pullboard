/** Relay identity, expiry, permission freshness and scoped credential isolation [H8, H1]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { ACCESS_WINDOW_MS } from '../../../relay/index.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { fetchFresh } from '../../tests/fixtures/http.js';
import { fixture } from '../../tests/fixtures/relay/auth.js';
import { login } from '../../tests/fixtures/relay/auth.js';
import { assertPersonUnlinkHistory } from '../../tests/fixtures/relay/exclusion.js';

test('a deleted and recreated repository cannot inherit the linked board [H8, H1]', async (t) => {
  const box = await fixture(t);
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  box.state.repositoryID = 200;
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), { code: 'NO_REPO_ACCESS' });
  await assert.rejects(box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository'), { code: 'BOARD_LINK_CONFLICT' });
});

test('expired browser/device grants cannot create sessions and concurrent polls consume only once [H8, H1]', async (t) => {
  const box = await fixture(t);
  const web = box.auth.beginWeb();
  const response = await fetch(web.authorizationURL, { redirect: 'manual' });
  const callback = new URL(response.headers.get('location'));
  box.advance(10 * 60_000);
  await assert.rejects(box.auth.finishWeb(callback.searchParams.get('state'), callback.searchParams.get('code'), web.binding), { code: 'OAUTH_STATE' });
  const expired = await box.auth.beginDevice();
  box.advance(expired.expiresIn * 1000);
  await assert.rejects(box.auth.pollDevice(expired.ticket), { code: 'OAUTH_EXPIRED' });
  const grant = await box.auth.beginDevice();
  box.state.deviceAuthorized = true;
  box.advance(grant.interval * 1000);
  const results = await Promise.all([box.auth.pollDevice(grant.ticket), box.auth.pollDevice(grant.ticket)]);
  assert.equal(results.filter(result => result.token).length, 1);
  assert.equal(results.filter(result => result.pending).length, 1);
  await assert.rejects(box.auth.pollDevice(grant.ticket), { code: 'OAUTH_EXPIRED' });
});

test('a public reader sees no board and cannot act, mint or revoke; refusal matches a missing board [H13,H14,H8]', async (t) => {
  const box = await fixture(t);
  box.state.public = true;
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  const existing = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'worker' });
  box.state.permission = 'none';
  box.advance(ACCESS_WINDOW_MS); // A role change takes effect when the cached grant's window ends [H8,H21].
  let missing;
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'absent', write: true }), error => {
    missing = { code: error.code, message: error.message }; return error.code === 'BOARD_NOT_LINKED';
  });
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), error => {
    assert.deepEqual({ code: error.code, message: error.message }, missing); return true;
  });
  assert.deepEqual(await box.auth.boardsFor(signed.token), []);
  await assert.rejects(box.auth.issueToken(signed.token, { board: 'alpha', agent: 'second' }), { code: 'BOARD_NOT_LINKED' });
  await assert.rejects(box.auth.revoke(signed.token, existing.id), { code: 'BOARD_NOT_LINKED' });
  box.state.permission = 'write';
  box.advance(ACCESS_WINDOW_MS); // A role change takes effect when the cached grant's window ends [H8,H21].
  assert.equal((await box.auth.authenticate(existing.token, { board: 'alpha', write: true })).agent, 'worker', 'denied revocation did not alter the token');
});

test('a public triage account sees its board but cannot act, mint or revoke its tokens [H13,H14,H8]', async (t) => {
  const box = await fixture(t);
  box.state.public = true;
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  const existing = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'worker' });
  box.state.permission = 'triage';
  box.advance(ACCESS_WINDOW_MS); // A role change takes effect when the cached grant's window ends [H8,H21].
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), { code: 'WRITE_REQUIRED' });
  assert.deepEqual((await box.auth.boardsFor(signed.token)).map(board => board.id), ['alpha']);
  assert.equal((await box.auth.authenticate(existing.token, { board: 'alpha' })).permission, 'triage');
  await assert.rejects(box.auth.issueToken(signed.token, { board: 'alpha', agent: 'second' }), { code: 'WRITE_REQUIRED' });
  await assert.rejects(box.auth.revoke(signed.token, existing.id), { code: 'WRITE_REQUIRED' });
});

test('write, maintain and admin accounts act and mint while private readers only see [H13,H14,H8]', async (t) => {
  const box = await fixture(t);
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  let existing;
  for (const permission of ['write', 'maintain', 'admin']) {
    box.state.permission = permission;
    box.advance(ACCESS_WINDOW_MS); // A role change takes effect when the cached grant's window ends [H8,H21].
    assert.equal((await box.auth.authenticate(signed.token, { board: 'alpha', write: true })).permission, permission);
    // Each seat gets one first mint (#579), so each permission mints its own seat.
    existing = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'worker-' + permission });
    assert.equal((await box.auth.authenticate(existing.token, { board: 'alpha', write: true })).permission, permission);
    await box.auth.revoke(signed.token, existing.id);
    await assert.rejects(box.auth.authenticate(existing.token, { board: 'alpha' }), { code: 'AUTH_REQUIRED' });
  }
  box.state.permission = 'write';
  box.advance(ACCESS_WINDOW_MS); // A role change takes effect when the cached grant's window ends [H8,H21].
  existing = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'reader' });
  box.state.permission = 'read';
  box.advance(ACCESS_WINDOW_MS); // A role change takes effect when the cached grant's window ends [H8,H21].
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), { code: 'WRITE_REQUIRED' });
  assert.equal((await box.auth.boardsFor(signed.token)).length, 1);
  assert.equal((await box.auth.authenticate(existing.token, { board: 'alpha' })).permission, 'read');
  await assert.rejects(box.auth.issueToken(signed.token, { board: 'alpha', agent: 'no' }), { code: 'WRITE_REQUIRED' });
  await assert.rejects(box.auth.revoke(signed.token, existing.id), { code: 'WRITE_REQUIRED' });
});

test('an explicit read role still hides a public board below triage [H13,H14,H8]', async (t) => {
  const box = await fixture(t);
  box.state.public = true;
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  box.state.permission = 'read';
  box.advance(ACCESS_WINDOW_MS); // A role change takes effect when the cached grant's window ends [H8,H21].
  assert.deepEqual(await box.auth.boardsFor(signed.token), []);
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), { code: 'BOARD_NOT_LINKED' });
  await assert.rejects(box.auth.issueToken(signed.token, { board: 'alpha', agent: 'worker' }), { code: 'BOARD_NOT_LINKED' });
});

test('relay off forgets expired and remotely deleted boards while preserving local rows [H1,H7,H18]', async (t) => {
  for (const cause of ['expired', 'other-client']) await t.test(cause, async (t) => {
    const box = await relayClientFixture(t);
    await box.link();
    const localBeforeOff = (await box.cli('export')).document.tables;
    const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
    if (cause === 'expired') box.advance(90);
    else {
      const phone = await box.phoneSession();
      const deleted = await fetchFresh(`${box.origin}/api/v1/boards/${link.board}`, {
        method: 'DELETE', headers: { authorization: `Bearer ${phone.token}`, 'x-pullboard-engine': String(ENGINE_VERSION) },
      });
      assert.equal(deleted.status, 200, 'an explicit person HTTP DELETE removes the remote board');
    }
    const callsBeforeOff = box.calls.length;
    const off = await box.cli('relay', 'off');
    assert.equal(off.code, 0);
    assert.equal(off.document.linked, false);
    assert.match(off.document.notice, /Local link removed/u);
    assert.equal(existsSync(box.linkFile), false, 'local link metadata is forgotten');
    assert.equal(existsSync(box.keyFile), false, 'device-only fallback key is forgotten');
    assertPersonUnlinkHistory((await box.cli('export')).document.tables, localBeforeOff);
    assert.ok(JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'relay-machine/state.json'), 'utf8')).excluded.includes(box.root),
      'the local opt-out remains durable after unlink');
    assert.equal(box.calls.slice(callsBeforeOff).some(call => call.method === 'DELETE'), false,
      'relay off never deletes the relay copy without its separate phone approval');
    const count = box.calls.length;
    assert.equal((await box.cli('relay', 'off')).code, 0);
    assert.equal((await box.cli('status')).code, 0);
    assert.equal(box.calls.length, count, 'repeated off and local commands make no relay connection');
  });
});

test('relay off completes local unlink when the relay is offline [H1,H7,H18]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const localBeforeOff = (await box.cli('export')).document.tables;
  await box.stopRelay();
  const callsBeforeOff = box.calls.length;
  const off = await box.cli('relay', 'off');
  assert.equal(off.code, 0, 'local unlink succeeds without a reachable relay');
  assert.match(off.document.notice, /relay copy stays until you approve deleting it on your phone/u);
  assert.equal(existsSync(box.linkFile), false);
  assert.equal(existsSync(box.keyFile), false);
  assert.ok(JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'relay-machine/state.json'), 'utf8')).excluded.includes(box.root),
    'the local opt-out remains durable');
  assertPersonUnlinkHistory((await box.cli('export')).document.tables, localBeforeOff);
  assert.equal(box.calls.length, callsBeforeOff, 'offline local unlink makes no relay request');
  assert.equal(box.calls.some(call => call.method === 'DELETE'), false, 'offline local unlink cannot delete the remote copy');
});

test('BOARD_INACTIVE appears once per command and resets for a second command in the same process [H18]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  box.advance(80);
  const result = await box.script(`
    import { main } from ${JSON.stringify(box.mainURL)};
    const counts = [];
    for (let i = 0; i < 2; i++) {
      let output = '';
      const code = await main(['status', '--json'], {
        cwd: process.cwd(), stdout: { write(part) { output += part; } },
        stderr: { write() {} },
      });
      const value = JSON.parse(output);
      counts.push({ code, warnings: (value.diagnostics || []).filter(line => line.includes('BOARD_INACTIVE')).length });
    }
    console.log(JSON.stringify(counts));
  `);
  assert.equal(result.code, 0);
  assert.deepEqual(result.document, [{ code: 0, warnings: 1 }, { code: 0, warnings: 1 }]);
});

test('unlinked board commands attempt zero outbound requests [H1,P5]', async (t) => {
  const box = await relayClientFixture(t);
  const result = await box.script(`
    import { main } from ${JSON.stringify(box.mainURL)};
    import http from 'node:http';
    import https from 'node:https';
    import net from 'node:net';
    import tls from 'node:tls';
    const attempts = [];
    const blocked = kind => { attempts.push(kind); throw new Error('unexpected outbound attempt: ' + kind); };
    globalThis.fetch = async () => blocked('fetch');
    http.request = (...args) => blocked('http.request');
    https.request = (...args) => blocked('https.request');
    net.connect = (...args) => blocked('net.connect');
    net.Socket.prototype.connect = function (...args) { return blocked('net.Socket.connect'); };
    tls.connect = (...args) => blocked('tls.connect');
    const codes = [];
    for (const args of [
      ['status'], ['list'], ['show', '1'], ['add', ${JSON.stringify(box.lane)}, 'another fixture item'],
      ['shout', ${JSON.stringify(box.lane)}, 'fixture local message'], ['relay'], ['relay', 'off'],
    ]) {
      try {
        codes.push(await main([...args, '--json'], {
          cwd: process.cwd(), stdout: { write() {} }, stderr: { write() {} },
        }));
      } catch { codes.push(-1); }
    }
    console.log(JSON.stringify({ attempts, codes }));
  `);
  assert.equal(result.code, 0);
  assert.deepEqual(result.document.attempts, [], 'fetch, HTTP(S), raw net and TLS connections are all watched');
  assert.ok(result.document.codes.every(code => code === 0), 'all ordinary local board commands succeed without transport');
});


