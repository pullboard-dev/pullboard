/** Over the real relay, only an authenticated person sender records a never-again fact [D1,H16,B26]. The case reads the
 * API1 state sequence, so it runs on the legacy wire (#903). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  closeBoard,
  events,
  PERSON,
} from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  applyRelayMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { rigorReport } from '../../../../packages/store/index.js';
import {
  decodeBoardKey,
  seal,
  unseal,
} from '../../../../packages/kernel/index.js';
import { legacyRelayClientFixture as relayClientFixture } from '../../tests/fixtures/relay/client.js';

/** Call the real relay API with one bearer credential and the current engine header. */
async function relay(box, path, token, { method = 'GET', body } = {}) {
  const response = await fetch(box.origin + path, {
    method, headers: { authorization: 'Bearer ' + token, 'x-pullboard-engine': String(ENGINE_VERSION), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

/** Mint a real board-scoped agent token for one seat through the machine credential. */
async function agentToken(box, link, agent) {
  const minted = await relay(box, '/auth/tokens', link.token, { method: 'POST', body: { board: link.board, agent } });
  assert.equal(minted.status, 201, `the relay mints a token for ${agent}: ${JSON.stringify(minted.body)}`);
  return minted.body.token;
}

test('only an authenticated person sender records a never-again over the relay [D1,H16,B26]', async (t) => {
  const box = await relayClientFixture(t);
  const added = await box.cliLocal('add', box.lane, 'Never-again target', '--criterion', 'a person marks a cause never again');
  assert.equal(added.code, 0, JSON.stringify(added.document));
  const id = added.document.item.item_id;
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const file = join(box.root, '.git', 'pullboard', 'board.sqlite');

  // A second replica starts from the native board as it is before any never-again move.
  assert.equal((await box.cli('status')).code, 0);
  const native = openBoard(file);
  const before = exportBoard(native);
  const start = Number(before.tables.board_meta.find((row) => row.meta_key === 'relay_applied_sequence')?.meta_value ?? 0);
  /** Seal the person-mode fact move a sender attempts, as the CLI would. */
  const attempt = (label, extra) => prepareEngineMove(native, 'appendFact', [id, {
    agentId: 'coordinator', kind: 'root-cause', text: `never again from ${label}`, cause: 'doctrine:C3', neverAgain: true, asPerson: true, channel: 'view', ...extra,
  }], { id: `rigor-relay-${label}` });
  const moves = [
    ['agent', attempt('agent', { agentId: 'rigor-relay-agent' })],
    ['machine', attempt('machine')],
    ['coordinator', attempt('coordinator')],
    ['coordinator-cause-only', prepareEngineMove(native, 'appendFact', [id, { agentId: 'coordinator', kind: 'note', text: 'a cause with no person mode', cause: 'doctrine:C3' }], { id: 'rigor-relay-cause-only' })],
    ['person', attempt('person')],
  ];
  closeBoard(native);
  const coordinator = link.agentTokens?.coordinator;
  assert.match(coordinator?.token ?? '', /^pa_[A-Za-z0-9_-]{43}$/u, 'relay on already supplied the coordinator credential');
  const tokens = {
    agent: await agentToken(box, link, 'rigor-relay-agent'),
    machine: link.token,
    coordinator: coordinator.token,
    'coordinator-cause-only': null,
    person: (await box.phoneSession()).token,
  };
  tokens['coordinator-cause-only'] = tokens.coordinator;
  let sequence = (await relay(box, `/api/v1/boards/${link.board}/state`, link.token)).body.state.sequence;
  const sent = [];
  for (const [label, move] of moves) {
    sequence += 1;
    sent.push([label, sequence]);
    const sealed = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(move)), { boardId: link.board, kind: 'move', sequence })).toString('base64url');
    const stored = await relay(box, `/api/v1/boards/${link.board}/moves`, tokens[label], { method: 'POST', body: { sequence, sealed } });
    assert.equal(stored.status, 200, `the relay stores the ${label} envelope: ${JSON.stringify(stored.body)}`);
  }

  // Read the sealed journal as the relay stored it, before the native replica checkpoints past it.
  const read = await relay(box, `/api/v1/boards/${link.board}/events?after=${start}`, link.token);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const journal = read.body.events;
  assert.ok(journal.length >= moves.length, 'the journal holds every attempted move');

  // The native replica replays the journal and records each refusal by its sealed sender.
  assert.equal((await box.cli('status')).code, 0, 'native replay records the refusals and the person fact');
  const exported = (await box.cliLocal('export')).document;
  const refused = new Map(exported.tables.event.filter((row) => row.event_kind === 'relay_refused')
    .map((row) => JSON.parse(row.event_detail)).map((detail) => [detail.sequence, detail.code]));
  for (const [label, at] of sent) {
    assert.equal(refused.get(at), label === 'person' ? undefined : 'RELAY_PERSON_ONLY',
      label === 'person' ? 'the person sender is accepted' : `the ${label} sender is refused RELAY_PERSON_ONLY`);
  }
  const facts = exported.tables.event.filter((row) => row.event_kind === 'fact');
  assert.deepEqual(facts.map((row) => [row.event_by, JSON.parse(row.event_detail).text]), [[PERSON, 'never again from person']],
    'only the person sender recorded a fact; nothing was recorded for the refused senders');
  assert.deepEqual(rigorReport(exported.tables.event.map((row) => ({ ...row })), { person: PERSON }).causes.map((cause) => cause.key), ['doctrine:C3']);

  // A second replica replays the same sealed journal, with the relay's sender metadata, identically.
  const replica = openBoard(join(box.root, '.git', 'rigor-replica.sqlite'));
  t.after(() => closeBoard(replica));
  importBoard(replica, before);
  for (const record of journal) {
    const plain = JSON.parse(new TextDecoder().decode(await unseal(key, Buffer.from(record.sealed, 'base64url'), { boardId: link.board, kind: record.kind, sequence: record.event_id })));
    if (record.kind !== 'move') continue;
    const outcome = applyRelayMove(replica, plain, { sequence: record.event_id, at: record.event_at, sender: record.sender, kind: record.kind });
    const label = moves.find(([, move]) => move.id === plain.id)?.[0];
    if (label) assert.equal(outcome.error?.code, label === 'person' ? undefined : 'RELAY_PERSON_ONLY', `${label} replays with the same verdict`);
  }
  const replayed = events(replica).filter((row) => ['fact', 'relay_refused'].includes(row.event_kind)).map(({ event_by, event_kind, event_detail }) => ({ event_by, event_kind, event_detail }));
  const nativeRows = exported.tables.event.filter((row) => ['fact', 'relay_refused'].includes(row.event_kind)).map(({ event_by, event_kind, event_detail }) => ({ event_by, event_kind, event_detail }));
  assert.deepEqual(replayed, nativeRows, 'two replicas replay the same journal identically');
});
