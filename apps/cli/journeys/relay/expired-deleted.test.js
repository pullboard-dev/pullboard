/** A relay copy deleted by its owner keeps local work and any pending move intact [H17,E9]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDeviceKeys,
  signDeviceEnrollment,
} from '../../../../packages/keys/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';

const CLI = fileURLToPath(new URL('../../pullboard.js', import.meta.url));


/** Commit one fixture-only opt-out choice so the ordinary command reads the same setting as production. */
function commitOutboxChoice(box, value) {
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.relay = { ...config.relay, outbox: value };
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${CLI}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', 'pullboard.json', 'SPEC.md'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore: configure relay outbox'], { cwd: box.root, env: box.env });
}

/** Enroll one cryptographically authenticated phone through the production native and HTTP paths. */
async function enrollDeletionPhone(box) {
  const machineURL = new URL('../../../../packages/link/index.js', import.meta.url).href;
  const linked = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const pendingResult = await box.script(`
    const { beginDeviceEnrollment } = await import(${JSON.stringify(machineURL)});
    console.log(JSON.stringify(beginDeviceEnrollment(${JSON.stringify(linked.board)},
      { account: ${JSON.stringify(linked.account)}, url: ${JSON.stringify(box.origin)} })));
  `);
  assert.equal(pendingResult.code, 0, 'the native machine creates a one-use phone enrollment');
  const pending = pendingResult.document;
  const phone = await box.phoneSession();
  const keys = await createDeviceKeys();
  const value = await signDeviceEnrollment(pending.secret, { v: 1, account: pending.account, locator: pending.locator,
    deviceId: keys.deviceId, publicKey: keys.publicKey, label: 'Deletion fixture phone', createdAt: new Date().toISOString() });
  const headers = { authorization: 'Bearer ' + phone.token, 'content-type': 'application/json', 'x-pullboard-engine': String(ENGINE_VERSION) };
  const path = '/api/v1/devices/enrollments/' + pending.locator;
  assert.equal((await fetch(box.origin + path, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal((await fetch(box.origin + path, { method: 'PUT', headers, body: JSON.stringify(value) })).status, 200);
  const delivered = await (await fetch(box.origin + path, { headers })).json();
  const accepted = await box.script(`
    const { acceptDeviceEnrollment } = await import(${JSON.stringify(machineURL)});
    await acceptDeviceEnrollment(${JSON.stringify(delivered.enrollment)});
    console.log(JSON.stringify({ accepted: true }));
  `);
  assert.equal(accepted.code, 0, 'the native machine authenticates the returned enrollment before trusting it');
  assert.equal((await fetch(box.origin + '/api/v1/devices/' + keys.deviceId, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal((await fetch(box.origin + path, { method: 'DELETE', headers })).status, 200);
  return { phone, headers, deviceId: keys.deviceId };
}

/** Pair an actual independent clone and leave one enrolled phone able to approve deletion. */
async function joinedDeletionFixture(t) {
  const box = await relayClientFixture(t);
  await box.link();
  const printed = await box.cliLocal('relay', 'pair');
  assert.equal(printed.code, 0, 'the owner publishes a real one-use computer pairing code');
  const joined = await box.otherDeviceJoin(printed.document.code);
  const phone = await enrollDeletionPhone(box);
  return { box, joined, ...phone };
}

test('a joined computer adds locally after the owner deletes the relay copy [H17,E9] [clause 1]', async (t) => {
  const { box, joined, headers, deviceId } = await joinedDeletionFixture(t);
  const board = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
  const off = await box.cliLocal('relay', 'off');
  assert.equal(off.code, 0, 'the owner unlinks locally before phone approval');
  const inbox = await (await fetch(box.origin + '/api/v1/devices/' + deviceId + '/approvals', { headers })).json();
  const approval = inbox.approvals.find(entry => entry.context.action === 'delete-board' && entry.context.board === board);
  assert.ok(approval, "the real phone receives the owner's deletion request");
  const removed = await fetch(box.origin + '/api/v1/devices/approvals/' + approval.context.id + '/authorize', { method: 'POST', headers, body: '{}' });
  assert.equal(removed.status, 200, 'the phone approves deletion through the real authorization endpoint');
  assert.equal((await removed.json()).result.deleted, board);
  const added = await joined.cli('add', box.lane, 'local work survives remote deletion');
  assert.equal(added.code, 0, added.document.error ? `${added.document.error.code}: ${added.document.error.message}` : 'the joined computer adds locally after deletion');
  const diagnostics = (added.document.diagnostics ?? []).join('\n');
  assert.match(diagnostics, /relay copy.*deleted|deleted.*relay copy/u, 'the diagnostic names the deleted shared copy');
  assert.doesNotMatch(diagnostics, /sign-in expired|AUTH_REQUIRED/u, 'deletion is never mislabeled as expired sign-in');
  const exported = await joined.cli('export');
  assert.equal(exported.code, 0);
  assert.equal(exported.document.tables.item.filter(row => row.item_title === 'local work survives remote deletion').length, 1,
    'the successful local move is recorded exactly once');
  const status = await joined.cli('status');
  assert.equal(status.code, 0);
  assert.equal(status.document.relay.linked, false, 'the deleted relay copy no longer intercepts later local moves');
});

test('the owner is warned that deleting the relay copy cuts off joined computers [H17,E9] [clause 1]', async (t) => {
  const { box, joined } = await joinedDeletionFixture(t);
  const off = await box.cliLocal('relay', 'off');
  assert.equal(off.code, 0);
  assert.match(off.document.notice, /joined computer.*lose.*shared copy/u, 'the warning names the consequence before phone approval');
  assert.ok(off.document.affectedMachines.includes(joined.machine), 'the warning identifies exactly which joined computer loses the shared copy');
  assert.equal(box.auth.linkedBoards().length, 1, 'the warning is returned before the phone has approved any deletion');
});


test('an agent token cannot inventory joined computers [H17,E9] [clause 1]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const token = await box.auth.issueToken(state.token, { board: state.board, agent: 'roster-probe' });
  const response = await fetch(box.origin + '/auth/machines?board=' + state.board, {
    headers: { authorization: 'Bearer ' + token.token },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'HUMAN_REQUIRED', 'a scoped agent can never list joined computers');
});


test('another board deletion never turns this board into local mode [H17,E9] [clause 1]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const other = await box.additionalBoard('separate shared board');
  const phone = await box.phoneSession();
  const token = await box.auth.issueToken(phone.token, { board: other.id, agent: 'foreign-deleted-board' });
  const before = (await box.cliLocal('export')).document.tables;
  const removed = await fetch(box.origin + '/api/v1/boards/' + other.id, { method: 'DELETE',
    headers: { authorization: 'Bearer ' + phone.token, 'x-pullboard-engine': String(ENGINE_VERSION) } });
  assert.equal(removed.status, 200, 'the phone deletes only the independent board copy');
  box.env.PULLBOARD_RELAY_TOKEN = token.token;
  try {
    const refused = await box.cliLocal('add', box.lane, 'must stay ordered on the surviving board');
    assert.equal(refused.code, 1, 'a deletion response naming another board never permits a local move');
    assert.equal(refused.document.error.code, 'RELAY_BOARD_DELETED');
    assert.equal(existsSync(box.linkFile), true, 'the surviving board keeps its ordered link');
  } finally { delete box.env.PULLBOARD_RELAY_TOKEN; }
  const exported = await box.cliLocal('export');
  assert.equal(exported.code, 0);
  assert.deepEqual(exported.document.tables, before, 'the refused move changes no local row');
  assert.equal((await box.cliLocal('status')).document.relay.board, state.board);
  assert.equal((await box.cliLocal('add', box.lane, 'the surviving board still syncs')).code, 0, 'ordinary ordered work remains available with its own credential');
});

test('a move pending acknowledgement when the relay copy is deleted is kept [H17,E9] [clause 1]', async t => {
 const box = await relayClientFixture(t);
 await box.link();
 const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
 const phone = await box.phoneSession();
 const firstTitle = 'locally originated move before deleted-copy lost acknowledgement';
 const result = await box.script(`
   const { main } = await import(${JSON.stringify(box.mainURL)});
   const realFetch = globalThis.fetch;
   let intercepted = false;
   globalThis.fetch = async function(input, init) {
     const response = await realFetch(input, init);
     if (!intercepted && init?.method === 'POST' && String(input).endsWith('/moves') && response.ok) {
       intercepted = true;
       const removed = await realFetch(${JSON.stringify(box.origin + '/api/v1/boards/' + state.board)}, {
         method: 'DELETE', headers: { authorization: ${JSON.stringify('Bearer ' + phone.token)}, 'x-pullboard-engine': ${JSON.stringify(String(ENGINE_VERSION))} }
       });
       if (removed.status !== 200) throw new Error('review fixture could not delete the remote copy');
       throw new TypeError('review fixture drops the already accepted move acknowledgement');
     }
     return response;
   };
   let stdout = '', stderr = '';
   const code = await main(['add', ${JSON.stringify(box.lane)}, ${JSON.stringify(firstTitle)}, '--json'], {
     cwd: ${JSON.stringify(box.root)}, stdout: {write(value) {stdout += value;}}, stderr: {write(value) {stderr += value;}}
   });
   console.log(JSON.stringify({code, intercepted, output: JSON.parse(stdout), stderr}));
 `);
 assert.equal(result.code, 0, 'the private capture process completed');
 assert.equal(result.document.intercepted, true, 'the real relay accepted the move before its acknowledgement was lost');
 assert.equal(box.auth.linkedBoards().length, 0, 'a real person-authenticated HTTP deletion completed before the transport refusal');
 const next = await box.cliLocal('add', box.lane, 'independent local work after deleted-copy lost acknowledgement');
 assert.equal(next.code, 0, 'subsequent local work succeeds');
 const exported = await box.cliLocal('export');
 assert.equal(exported.code, 0);
 assert.equal(exported.document.tables.item.filter(row => row.item_title === firstTitle).length, 1,
   'the local sender retains its earlier accepted obligation across the deletion and lost acknowledgement');
});

test('a deleted-copy pending move survives interrupted cleanup and is returned only once on retry [H17,E9] [clause 1]', async t => {
  const box = await relayClientFixture(t);
  // This case loses the acknowledgement of a move sent in the foreground, so its board sends before it applies.
  commitOutboxChoice(box, false);
  await box.link();
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const phone = await box.phoneSession();
  const firstTitle = 'pending move retained through an interrupted local deletion cleanup';
  const captured = await box.script(`
    const { main } = await import(${JSON.stringify(box.mainURL)});
    const realFetch = globalThis.fetch;
    let intercepted = false;
    globalThis.fetch = async function(input, init) {
      const response = await realFetch(input, init);
      if (!intercepted && init?.method === 'POST' && String(input).endsWith('/moves') && response.ok) {
        intercepted = true;
        const removed = await realFetch(${JSON.stringify(box.origin + '/api/v1/boards/' + state.board)}, {
          method: 'DELETE', headers: { authorization: ${JSON.stringify('Bearer ' + phone.token)}, 'x-pullboard-engine': ${JSON.stringify(String(ENGINE_VERSION))} }
        });
        if (removed.status !== 200) throw new Error('the private phone could not delete the accepted copy');
        throw new TypeError('the private fixture loses the accepted move acknowledgement');
      }
      return response;
    };
    let firstOutput = '';
    const firstCode = await main(['add', ${JSON.stringify(box.lane)}, ${JSON.stringify(firstTitle)}, '--json'], {
      cwd: ${JSON.stringify(box.root)}, stdout: {write(value) {firstOutput += value;}}, stderr: {write() {}}
    });
    const fs = await import('node:fs');
    const { syncBuiltinESMExports } = await import('node:module');
    const rename = fs.default.renameSync;
    let cleanupInterrupted = false;
    fs.default.renameSync = function(from, to) {
      if (!cleanupInterrupted && String(to).endsWith('/relay-deleted.json')) {
        cleanupInterrupted = true;
        fs.default.renameSync = rename;
        syncBuiltinESMExports();
        throw new Error('the private fixture interrupts deletion-marker persistence');
      }
      return rename(from, to);
    };
    syncBuiltinESMExports();
    let cleanupOutput = '';
    let cleanupCode;
    let cleanupError;
    try {
      cleanupCode = await main(['add', ${JSON.stringify(box.lane)}, 'new work after interrupted deletion cleanup', '--json'], {
        cwd: ${JSON.stringify(box.root)}, stdout: {write(value) {cleanupOutput += value;}}, stderr: {write() {}}
      });
    } catch (error) {
      if (error.message !== 'the private fixture interrupts deletion-marker persistence') throw error;
      cleanupError = error.message;
    } finally { fs.default.renameSync = rename; syncBuiltinESMExports(); }
    const { localRecords } = await import(${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)});
    const { openBoard } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
    const beforeCleanup = localRecords(openBoard, ${JSON.stringify(box.root)}, board => ({
      firstCount: board.db.prepare('SELECT COUNT(*) AS count FROM item WHERE item_title=?').get(${JSON.stringify(firstTitle)}).count,
      cursor: board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='relay_applied_sequence'").get()?.meta_value
    }));
    const stillLinked = fs.existsSync(${JSON.stringify(box.linkFile)});
    console.log(JSON.stringify({ firstCode, intercepted, cleanupInterrupted, cleanupCode, cleanupError, firstOutput, cleanupOutput, beforeCleanup, stillLinked }));
  `);
  assert.equal(captured.code, 0, 'the private capture completed both real CLI invocations');
  assert.equal(captured.document.intercepted, true, 'the relay accepted the original move before its reply was lost');
  assert.equal(captured.document.cleanupInterrupted, true, 'the next CLI reached the exact deletion-marker write');
  assert.equal(captured.document.cleanupError, 'the private fixture interrupts deletion-marker persistence',
    'the private fault interrupts the command at the marker boundary');
  assert.equal(box.auth.linkedBoards().length, 0, 'the real person-authenticated deletion remains complete');
  assert.equal(captured.document.stillLinked, true, 'interruption leaves the original pending link available for recovery');
  const cursor = document => document.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence')?.meta_value;
  const savedCursor = captured.document.beforeCleanup.cursor;
  assert.equal(captured.document.beforeCleanup.firstCount, 1,
    'the pending native move is durable before link cleanup can be interrupted');
  const next = await box.cliLocal('add', box.lane, 'unrelated roadmap planning after the relay copy went away', '--not-duplicate-of', '2 different local work');
  assert.equal(next.code, 0, 'a fresh invocation completes cleanup and different local work: ' + JSON.stringify(next));
  const repeated = await box.cliLocal('add', box.lane, firstTitle);
  assert.equal(repeated.code, 0, 'the interrupted original command receives its retained native outcome');
  const exported = await box.cliLocal('export');
  assert.equal(exported.code, 0);
  assert.equal(exported.document.tables.item.filter(row => row.item_title === firstTitle).length, 1,
    'neither repeated cleanup nor the original command retry duplicates the native move');
  assert.equal(cursor(exported.document), savedCursor, 'repeated cleanup does not fabricate another relay position');
  const marker = JSON.parse(readFileSync(join(box.root, '.git', 'pullboard', 'relay-deleted.json'), 'utf8'));
  assert.equal(JSON.stringify(marker).includes(state.token), false, 'the deletion notice retains no bearer credential');
  assert.equal(marker.recovered, undefined, 'reporting the original outcome consumes its recovery pointer');
  assert.equal((await box.cliLocal('add', box.lane, firstTitle, '--not-duplicate-of', '2 an intentional new copy')).code, 0);
  const later = await box.cliLocal('export');
  assert.equal(later.document.tables.item.filter(row => row.item_title === firstTitle).length, 2,
    'after reporting the retained outcome, the same command can intentionally make new local work');
});
