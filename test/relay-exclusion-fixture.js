/** Real CLI and loopback relay controls preserve person opt-out and deleted-copy recovery [H5,H17,B26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_VERSION } from '../src/engine-metadata.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { fetchFresh } from './http-fixture.js';
import { decodeBoardKey } from '../src/seal.js';
import { openPagedSnapshot } from '../src/relay-page-layout.js';

/** Read only this fixture's private local machine settings. */
function machine(box) {
  return JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'relay-machine/state.json'), 'utf8'));
}

/** A real person deletes a remote copy; ordinary recovery must retain local history and request new authority. */
export async function deletedCopyRelinks(t) {
  const box = await relayClientFixture(t);
  await box.link();
  const old = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const before = (await box.cli('export')).document.tables;
  const phone = await box.phoneSession();
  const removed = await fetchFresh(`${box.origin}/api/v1/boards/${old.board}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${phone.token}`, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(removed.status, 200, 'the person genuinely removes the remote copy');
  const detected = await box.cli('relay', 'status');
  assert.equal(detected.code, 0);
  assert.equal(machine(box).excluded.includes(box.root), false, 'a deleted copy never creates a durable person exclusion');
  const stale = await fetchFresh(`${box.origin}/api/v1/boards/${old.board}/state`, {
    headers: { authorization: `Bearer ${old.token}`, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(stale.status, 410, 'deleted credentials remain tombstoned and cannot recreate their board');
  const linked = await box.cli('relay', 'on', '--url', box.origin);
  assert.equal(linked.code, 0, 'the existing genuine sign-in flow grants the replacement link: ' + (linked.document?.error?.code ?? 'no refusal code'));
  const fresh = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.notEqual(fresh.board, old.board, 'the deleted remote epoch is replaced rather than resurrected');
  assert.notEqual(fresh.token, old.token, 'recovery obtains newly authorized machine credentials');
  const state = await fetchFresh(`${box.origin}/api/v2/boards/${fresh.board}/state`, {
    headers: { authorization: `Bearer ${fresh.token}`, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(state.status, 200, 'the fresh link actually uploads a relay snapshot');
  const head = (await state.json()).state;
  const key = decodeBoardKey(readFileSync(join(box.env.PULLBOARD_HOME, 'relay-keys', fresh.board + '.key'), 'utf8').trim());
  const opened = await openPagedSnapshot(head.root, { key, boardId: fresh.board, sequence: head.sequence,
    async get(id, parents) {
      const response = await fetchFresh(`${box.origin}/api/v2/boards/${fresh.board}/objects/${id}?pin=${encodeURIComponent(head.read.id)}`
        + (parents.length ? '&via=' + encodeURIComponent(parents.join(',')) : ''), {
        headers: { authorization: `Bearer ${fresh.token}`, 'x-pullboard-engine': String(ENGINE_VERSION) },
      });
      assert.equal(response.status, 200, 'only actual authenticated snapshot pages supply the recovered native document');
      return Buffer.from((await response.json()).page.sealed, 'base64url');
    },
  }, { maxEngine: ENGINE_VERSION });
  const remote = await opened.native();
  assert.deepEqual(remote.tables.item, before.item, 'the uploaded sealed snapshot actually contains the existing native items');
  assert.deepEqual(remote.tables.event.slice(0, before.event.length), before.event, 'unsealed remote history retains the entire original native event prefix');
  const after = (await box.cli('export')).document.tables;
  assert.deepEqual(after.item, before.item, 'the native items survive recovery');
  assert.deepEqual(after.event.slice(0, before.event.length), before.event, 'the complete existing native event prefix survives');
  assert.equal(machine(box).excluded.includes(box.root), false);
}

/** A real person exclusion is visible and an explicit successful sign-in clears it with an explanation. */
export async function relayOnClearsExclusion(t) {
  const box = await relayClientFixture(t);
  await box.link();
  assert.equal((await box.cli('relay', 'off')).code, 0);
  assert.equal(machine(box).excluded.includes(box.root), true, 'the person may persist an opt-out');
  const audit = (await box.cli('export')).document.tables.event.filter(row => row.event_kind === 'relay_exclusion').at(-1);
  assert.equal(audit.event_by, 'person');
  assert.equal(JSON.parse(audit.event_detail).path, 'relayOff');
  const status = await box.cli('status');
  assert.equal(status.code, 0);
  assert.equal(status.document.relay.excluded, true, 'normal status makes the durable opt-out visible');
  assert.equal(status.document.relay.exclusion.reason, 'person relay off');
  assert.ok(Number.isFinite(Date.parse(status.document.relay.exclusion.at)), 'new exclusions retain their actual time');
  assert.match(status.document.relay.exclusion.next, /pullboard relay on/u);
  box.refuseSnapshotWrites(true);
  const pending = await box.cli('relay', 'on', '--url', box.origin);
  assert.equal(pending.code, 0, 'a refused checkpoint retains a retryable authorized link');
  assert.equal(machine(box).excluded.includes(box.root), true, 'a pending upload cannot prematurely clear the opt-out');
  assert.equal((await box.cli('status')).document.relay.excluded, true, 'pending-link status still exposes the uncleared exclusion');
  box.refuseSnapshotWrites(false);
  const linked = await box.cli('relay', 'on', '--url', box.origin);
  assert.equal(linked.code, 0);
  assert.match(linked.document.notice, /exclusion.*clear|clear.*exclusion/iu, 'successful explicit on names the cleared exclusion');
  assert.equal(machine(box).excluded.includes(box.root), false);
  assert.equal((await box.cli('status')).document.relay.excluded, undefined, 'a cleared exclusion is no longer reported');
  const count = (await box.cli('export')).document.tables.event.filter(row => row.event_kind === 'relay_exclusion').length;
  box.env.AI_AGENT = '1'; box.env.SSH_CONNECTION = 'fixture remote agent';
  const agentOff = await box.cli('relay', 'off');
  delete box.env.AI_AGENT; delete box.env.SSH_CONNECTION;
  assert.equal(agentOff.code, 0, 'an agent can still stop local syncing');
  assert.equal(machine(box).excluded.includes(box.root), false, 'an agent cannot persist a person opt-out');
  assert.equal((await box.cli('export')).document.tables.event.filter(row => row.event_kind === 'relay_exclusion').length, count, 'an agent cannot create person exclusion provenance');
}

/** Person opt-out appends exactly one attributed native intent and preserves every prior row. */
export function assertPersonUnlinkHistory(after, before) {
  const sequences = before.sqlite_sequence.map(row => row.name === 'event' ? { ...row, seq: row.seq + 1 } : row);
  assert.deepEqual(after.sqlite_sequence, sequences, 'only the event allocation advances, by exactly one audit');
  assert.deepEqual({ ...after, event: before.event, sqlite_sequence: before.sqlite_sequence }, before, 'unlink preserves every other native table and sequence');
  assert.deepEqual(after.event.slice(0, before.event.length), before.event, 'unlink preserves the exact previous event prefix');
  assert.equal(after.event.length, before.event.length + 1, 'person unlink adds exactly its audit intent');
  const receipt = after.event.at(-1);
  assert.equal(receipt.event_by, 'person');
  assert.equal(receipt.event_kind, 'relay_exclusion');
  const detail = JSON.parse(receipt.event_detail);
  assert.equal(detail.path, 'relayOff');
  assert.equal(detail.reason, 'person relay off');
  assert.equal(detail.action, 'exclude');
  assert.equal(detail.channel, 'terminal');
  assert.ok(Number.isFinite(Date.parse(receipt.event_at)));
}
