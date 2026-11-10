/** Exact signed-request provenance must replace optional SSH signing at native apply, never named identity [E22,H16]. */
import { loadDoctrine } from '../../../../../packages/doctrine/index.js';
import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
} from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import {
  attestAuthority,
  setPersonSigning,
  verifiedPasskeyRowDecision,
} from '../../../../../packages/person/index.js';
import { presenceAttestation } from '../../../../../packages/person/index.js';
import { preparePersonRequest } from '../../../../../packages/person/light.js';
import {
  prepareRowDecisions,
  planRowApply,
} from '../../../../../packages/spec/index.js';
import { loadConfig } from '../../../../../packages/config/index.js';
import {
  applyRelayMove,
  prepareEngineMove,
} from '../../../../../packages/state/index.js';
import {
  receivePersonRequest,
  personRequestRecords,
  requestIntentDigest,
  requestStageText,
} from '../../../../../packages/link/index.js';
import { relayClientFixture } from '../relay/client.js';
import { relayStampKey } from './stamp.js';
import { runFixtureGit } from '../child.js';

/** A valid OpenSSH public line for a fixture-only public key; no SSH private key or signing subprocess exists. */
function sshPublicLine(publicKey) {
  const name = Buffer.from('ssh-ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const length = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
  return `fixture@example.invalid namespaces="pullboard-signoff" ssh-ed25519 ${Buffer.concat([length(name.length), name, length(raw.length), raw]).toString('base64')}\n`;
}

/** Exercise actual engine receipt validation and native apply on an owned project, with a separately pinned fixture relay key. */
export async function optionalPasskeyApply(t, { throughCli = false, fabricatedMetadata = false, syntheticEvent = false } = {}) {
  const box = await relayClientFixture(t);
  const specFile = join(box.root, 'SPEC.md');
  const text = 'An optional SSH row approved by its exact passkey request.';
  writeFileSync(specFile, readFileSync(specFile, 'utf8') + `\n- G21 [draft, must] ${text} | gate: review\n`);
  const publicPair = generateKeyPairSync('ed25519');
  const allowed = sshPublicLine(publicPair.publicKey);
  mkdirSync(join(box.root, '.pullboard'), { recursive: true });
  writeFileSync(join(box.root, '.pullboard', 'signers'), allowed);
  writeFileSync(join(box.root, '.pullboard', 'signers.initial'), createHash('sha256').update(allowed).digest('hex') + '\n');
  writeFileSync(join(box.root, '.pullboard', 'first-commit'), runFixtureGit(['rev-list', '--max-parents=0', 'HEAD'], { cwd: box.root, env: box.env }) + '\n');
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  // The relay's own stamp key, as the relay vouches for it to this process (#408).
  const relayKey = relayStampKey(box);
  attestAuthority(board, box.origin, relayKey.authority);
  setPersonSigning(board, { agentId: 'coordinator', signed: true });
  const document = preparePersonRequest({ verb: 'spec-approve', args: { ids: 'G21' } }, randomUUID(), [{ id: 'G21', text, source: readFileSync(specFile, 'utf8').split(/\r?\n/u).find(line => line.startsWith('- G21 ')) }]);
  const boardId = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get().meta_value;
  const presence = { board: boardId, request: document.id, digest: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
    credential: 'fixture-passkey', at: Date.now() };
  presence.signature = sign(null, presenceAttestation(presence), relayKey.privateKey).toString('base64url');
  const at = new Date().toISOString();
  receivePersonRequest(board, document, { sequence: 1, at, sender: { kind: 'person', userId: 'fixture-user', presence } });
  const executor = 'fixture-executor';
  let sequence = 1;
  /** Execute normal sealed engine operations with actual stable request stage bindings. */
  function execute(operation, args, phase) {
    const record = personRequestRecords(board).find(entry => entry.id === document.id);
    const move = prepareEngineMove(board, operation, args);
    move.personRequest = { id: document.id, executor, phase, digest: requestIntentDigest(record) };
    const outcome = applyRelayMove(board, move, { sequence: ++sequence, at, kind: 'move', sender: { kind: 'machine', userId: 'fixture-user', machine: 'fixture-native-device' } });
    assert.equal(outcome.error, undefined, JSON.stringify(outcome));
    return outcome.result;
  }
  const intake = personRequestRecords(board).find(entry => entry.id === document.id);
  execute('shout', [{ from: 'person', to: 'coordinator', text: requestStageText(intake, 'claim'), lanes: Object.keys(loadConfig(box.root).lanes) }], 'claim');
  const decisions = prepareRowDecisions(box.root, loadConfig(box.root), { ids: ['G21'], decision: 'approve', by: 'person',
    sshSign: false, passkeyRequest: document.id, on: at, commit: runFixtureGit(['rev-parse', 'HEAD'], { cwd: box.root, env: box.env }) }, { loadDoctrine });
  // Keep this explicit even before prepareRowDecisions retains the new provenance option.
  decisions.forEach(record => { record.passkeyRequest = document.id; });
  assert.equal(decisions[0].signature, undefined, 'optional passkey approval does not invoke SSH signing');
  execute('recordRowDecisions', [{ agentId: 'person', channel: 'view', decisions }], 'execute');
  if (fabricatedMetadata) {
    const genuine = store.rowDecisions(board)[0];
    assert.equal(verifiedPasskeyRowDecision(board, genuine), true, 'the genuine committed receipt is a positive control');
    const missingEvent = board.db.prepare('SELECT MAX(event_id) AS id FROM event').get().id + 1000;
    assert.equal(board.db.prepare('SELECT event_id FROM event WHERE event_id=?').get(missingEvent), undefined);
    const fabricated = { ...genuine, event: missingEvent, source: genuine.source.replace('gate: review', 'gate: true'),
      replacement: genuine.replacement.replace('gate: review', 'gate: true') };
    assert.notEqual(fabricated.source, genuine.source, 'the attack changes a real row gate, not its signed displayed text');
    let syntheticMove;
    if (syntheticEvent) {
      const { event, at: recordedAt, applied, appliedAt, ...body } = fabricated;
      board.db.prepare('INSERT INTO event(event_id,event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?,?)')
        .run(missingEvent, recordedAt, 'person', 'row_decision', null, JSON.stringify({ record: body, channel: 'view' }));
      const original = personRequestRecords(board).find(record => record.id === document.id);
      const receipt = JSON.parse(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('relay_receipt_' + original.resultMove).meta_value);
      syntheticMove = JSON.parse(receipt.move);
      syntheticMove.id = randomUUID();
      syntheticMove.args[0].decisions = [body];
      receipt.move = JSON.stringify(syntheticMove);
      receipt.outcome.result = [fabricated];
      receipt.outcome.events = [board.db.prepare('SELECT * FROM event WHERE event_id=?').get(missingEvent)];
      board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run('relay_receipt_' + syntheticMove.id, JSON.stringify(receipt));
    }
    const records = personRequestRecords(board).map(record => record.id === document.id
      ? { ...record, result: [fabricated], ...(syntheticMove ? { resultMove: syntheticMove.id } : {}) } : record);
    board.db.prepare('UPDATE board_meta SET meta_value=? WHERE meta_key=?').run(JSON.stringify(records), 'relay_person_requests');
    board.db.prepare('UPDATE board_meta SET meta_value=? WHERE meta_key=?').run(JSON.stringify([fabricated]), 'row_decisions');
    const before = readFileSync(specFile, 'utf8');
    assert.ok(before.includes(genuine.source));
    writeFileSync(specFile, before.replace(genuine.source, fabricated.replacement));
    const status = await box.cli('status');
    assert.equal(status.code, 0, JSON.stringify(status.document));
    assert.equal(status.document.specApprovalBaseline?.pending, false);
    assert.equal(Boolean(board.db.prepare('SELECT event_id FROM event WHERE event_id=?').get(missingEvent)), syntheticEvent,
      'the control explicitly distinguishes fabricated metadata from a raw-inserted event and fabricated engine receipt');
    assert.deepEqual({ verified: verifiedPasskeyRowDecision(board, fabricated),
      falselyConfirmed: !status.document.needs.some(need => need.kind === 'agent-approved' && need.id === 'G21') },
    { verified: false, falselyConfirmed: false }, 'mutable receipt metadata cannot invent a committed approval or clear its changed gate');
    return;
  }
  if (throughCli) {
    // An unlinked CLI has no relay to vouch for the stamp, so the decision this process attested does not apply there:
    // only the relay's own answer counts, never a key stored on the board (#408). The linked apply is in team.test.js.
    const before = readFileSync(specFile, 'utf8');
    const applied = await box.cli('spec', 'apply');
    assert.equal(applied.code, 1, JSON.stringify(applied.document));
    assert.equal(applied.document.error.code, 'MISSING_SIGNATURE', 'the unverified passkey approval is not applied');
    assert.equal(readFileSync(specFile, 'utf8'), before, 'the row stays a draft');
    return;
  }
  const plan = planRowApply(box.root, loadConfig(box.root), store.rowDecisions(board), {
    passkeyDecision: record => verifiedPasskeyRowDecision(board, record),
  }, { loadDoctrine });
  assert.equal(plan.files.length, 1);
  assert.match(plan.files[0].after, /- G21 \[approved, must\] An optional SSH row approved by its exact passkey request\./u);
  assert.equal(readFileSync(specFile, 'utf8').includes('G21 [draft'), true, 'planning does not write before the caller commits its ordered apply');
}

/** Reuse real engine intake and exercise the ordinary native command and approval projection. */
export function optionalPasskeyApplyThroughCli(t) { return optionalPasskeyApply(t, { throughCli: true }); }

/** A copied valid signature cannot authenticate a fabricated mutable result or nonexistent committed event. */
export function rejectFabricatedPasskeyMetadata(t) { return optionalPasskeyApply(t, { fabricatedMetadata: true }); }

/** An appended row event and mutable engine receipt still cannot change the source bound by a genuine passkey. */
export function rejectSyntheticPasskeyEvent(t) { return optionalPasskeyApply(t, { fabricatedMetadata: true, syntheticEvent: true }); }
