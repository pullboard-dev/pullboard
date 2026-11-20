/** Additional real native mutations for the complete reader inventory [H5,H16,A2]. */
import assert from 'node:assert/strict';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveCommit } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { barReadiness } from '../../../verify/index.js';
import { revisionReference } from '../../../spec/index.js';
import { receiptBody } from '../../heavy.js';
import { requireHandoffActive } from '../../../state/light.js';
import { preparePersonRequest } from '../../../person/light.js';
import { closeLandingTestDefect } from '../../../store/index.js';

/** Outside metadata is synthetic fixture input; these calls make no GitHub or owner-authentication assurance claim. */
export async function seedOutside(context) {
  const { board, box, store, exercise } = context;
  const text = '{"rows":[]}';
  const outside = await exercise('intakeOutside', () => store.intakeOutside(board, { agentId: 'coordinator',
    source: { kind: 'pull-request', repository: 'fixture/repository', number: 1282, author: 'parity-contributor',
      state: 'open', maintainerReplied: false, commit: 'd'.repeat(40), tree: 'e'.repeat(40), base: 'f'.repeat(40),
      files: ['synthetic-parity.txt'], sensitive: true },
    item: { lane: box.lane, title: 'Outside projection input', criterion: 'Complete readers retain outside metadata', check: 'true', route: 'strong' },
    frozen: { text, digest: createHash('sha256').update(text).digest('hex') } }));
  if (outside !== null) await exercise('approveOutside', () => store.approveOutside(board, outside, { agentId: 'person' }));
}

/** Preserve gate and landing receipt shapes without pretending that this state fixture executed those jobs. */
export async function seedLandingObservations(context) {
  const { board, box, store, exercise } = context;
  const command = 'synthetic projection receipt; no command executed';
  const head = resolveCommit(box.root, 'HEAD');
  const tree = tryGit(box.root, ['rev-parse', `${head}^{tree}`]).stdout.trim();
  const receipt = { version: 1, id: randomUUID(), kind: 'gate', head, main: head, tree,
    command: createHash('sha256').update(command).digest('hex'), green: false,
    failures: [{ file: 'test/parity-synthetic.test.js', name: 'Synthetic projection observation', durationMs: 1 }],
    at: board.clock.now().toISOString(), load: { average: [0, 0, 0], cpus: 1, freeMB: 100 } };
  const folder = join(box.root, '.git', 'pullboard', 'gate-receipts');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${receipt.id}.json`), receiptBody(receipt));
  await exercise('recordGateRun', () => board.enginePorts.store.recordGateRun(board, { agentId: 'coordinator', receipt, lane: box.lane }));
  await exercise('recordLandingWaiver', () => store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal',
    id: 'parity-synthetic-waiver', test: 'test/parity-synthetic.test.js', until: '2099-01-01T00:00:00Z', reason: 'Synthetic projection fixture; no real test waiver' }));
  await exercise('recordLandingFlake', () => store.recordLandingFlake(board, { agentId: 'coordinator', test: 'test/parity-synthetic.test.js',
    hash: 'a'.repeat(64), names: ['Synthetic projection observation'], lane: box.lane, batchId: randomUUID() }));
  const defect = await exercise('recordLandingTestDefect', () => store.recordLandingTestDefect(board, { agentId: 'coordinator', test: 'test/parity-synthetic-defect.test.js',
    hash: 'b'.repeat(64), blob: head, trunkBlob: null, names: ['Synthetic projection defect'], lane: box.lane, batchId: randomUUID(), branch: 'refs/heads/main' }));
  if (defect) await exercise('closeLandingTestDefect', () => closeLandingTestDefect(board, { agentId: 'coordinator', branch: defect.branch,
    test: defect.test, item: defect.item, commit: head }));
}

/** Membership data exercises projection only; key-handover signature verification is deliberately outside this fixture. */
export async function seedMembership(context) {
  const { board, store, exercise } = context;
  await exercise('setBoardMembers', () => store.setBoardMembers(board, { agentId: 'coordinator', document: {
    body: { v: 1, board: store.boardId(board), repository: 'fixture/repository', revision: (store.readBoardMembers(board)?.body.revision ?? 0) + 1, members: ['parity-member'] },
    by: 'parity-owner', signature: '-----BEGIN SSH SIGNATURE-----\nSynthetic projection fixture; not a verified signature\n-----END SSH SIGNATURE-----' } }));
}

/** Coordinator path upkeep and escalation both have real intermediate projection effects. */
export async function seedAdministrative(context) {
  const { board, box, store, exercise } = context;
  await exercise('ensureCoordinator', () => store.ensureCoordinator(board, join(box.root, 'moved-coordinator')));
  await exercise('ensureCoordinator', () => store.ensureCoordinator(board, box.root));
  const item = store.addItem(board, { by: 'coordinator', lane: box.lane, title: 'Escalated projection input', criterion: 'Route changes remain visible', route: 'mid',
    brief: 'Files: src/projection.js\nTest: the synthetic escalation retains its route and history in both reader projections.',
    check: 'node --test test/projection.test.js' });
  await exercise('escalate', () => store.escalate(board, item, { agentId: 'coordinator', note: 'Synthetic projection escalation' }));
}

/** Complete a synthetic accepted-item batch through real recording operations, without pushing Git or claiming LAND. */
export async function seedBatch(context) {
  const { board, box, store, exercise, agent, reviewer, submitFixture } = context;
  const head = resolveCommit(box.root, 'HEAD');
  const tree = tryGit(box.root, ['rev-parse', `${head}^{tree}`]).stdout.trim();
  const frozen = { text: '{"rows":[]}', digest: 'parity-batch-frozen' };
  const item = store.addItem(board, { by: 'coordinator', lane: box.lane, title: 'Synthetic batch projection', criterion: 'Readers retain batch state' });
  store.claim(board, item, { agentId: agent, lane: box.lane, leaseMs: 3600000, head, freeze: () => frozen });
  submitFixture(board, item, { agentId: agent, commit: head, tree });
  store.reserveReview(board, item, { agentId: reviewer, lane: 'tests', leaseMs: 3600000, policy: 'any' });
  store.verify(board, item, { agentId: reviewer, decision: 'ACCEPT', head, digest: frozen.digest, policy: 'any', familyPolicy: 'off',
    note: 'Synthetic state only; no gate or independent assurance claimed.', review: { commit: head, head, trunk: head, paths: [] } });
  const batch = { version: 1, id: randomUUID(), state: 'pushed', base: head, tip: head, root: box.root,
    branch: 'refs/heads/main', owner: 'private-projection-fixture', logPath: join(box.root, 'synthetic-batch.log'),
    items: [{ id: item, commit: head, merge: head, reviewedCommit: head }] };
  await exercise('recordLandingBatch', () => store.recordLandingBatch(board, { agentId: 'coordinator', batch }));
  await exercise('finishLandingBatch', () => store.finishLandingBatch(board, { agentId: 'coordinator', id: batch.id, tip: head }));
}

/** Native takeover and lease records use explicitly synthetic private-fixture authority, not a live session claim. */
export async function seedCoordinatorAuthority(context) {
  const { board, store, exercise } = context;
  const previous = board.verifierStanding;
  board.verifierStanding = { lineage: 'parity-private-synthetic-lineage' };
  try {
    await exercise('takeCoordinator', () => store.takeCoordinator(board, { agentId: 'coordinator', machine: 'parity-fixture', name: 'Parity fixture' }));
    const token = randomUUID();
    const request = await exercise('landingLeaseMove', () => store.landingLeaseMove(board, { agentId: 'coordinator', action: 'request',
      token, branch: 'refs/heads/main', pid: process.pid }));
    if (request) await exercise('landingLeaseMove', () => store.landingLeaseMove(board, { agentId: 'coordinator', action: 'release', token,
      generation: request.generation, branch: 'refs/heads/main', pid: process.pid }));
  } finally { board.verifierStanding = previous; }
}


/** Spec receipts retain exact immutable sources; fixture parent identities do not assert real-world independence. */
export async function seedSpecOutcomes(context) {
  const { board, store, exercise, agent, reviewer } = context;
  const row = { id: 'P1282', text: 'A projection-only draft.', gate: 'review', tier: 'must', section: 'P · Projection', target: 'spec' };
  store.draftSpecRow(board, { agentId: agent, row });
  await exercise('recordRowVerification', () => store.recordRowVerification(board, { agentId: reviewer,
    source: '- P1282 [draft, must] A projection-only draft. | gate: review', decision: 'accepted', reason: 'Synthetic projection receipt; no external assurance.' }));
  const revision = store.draftSpecRow(board, { agentId: agent, row: { id: 'P1283', target: 'spec', revises: 'P1284',
    text: 'Revised projection text.', gate: 'review', tier: 'must', section: 'P · Projection', status: 'approved', file: 'SPEC.md',
    source: '- P1284 [approved, must] Original projection text. | gate: review',
    replacement: '- P1284 [approved, must] Revised projection text. | gate: review', reason: 'Synthetic revision disposition.' } });
  await exercise('decideSpecRevisions', () => store.decideSpecRevisions(board, { agentId: 'person', channel: 'terminal', decisions: [{
    version: 1, type: 'row-decision', kind: 'spec', id: revision.revises, file: revision.file, source: revision.source,
    replacement: revision.replacement, text: revision.text, decision: 'decline', reason: 'Synthetic projection-only decline.', revision: revisionReference(revision) }] }));
}

/** A bar signature is synthetic projection input, with complete recorded readiness and explicit fixture identities. */
export async function seedBarSignature(context) {
  const { board, box, store, exercise, reviewer } = context;
  store.setBarReady(board, { agentId: 'coordinator', enabled: true });
  const head = resolveCommit(box.root, 'HEAD');
  const check = 'node --test --test-name-pattern "projection witness" test/projection.test.js';
  const item = store.addItem(board, { by: 'coordinator', lane: box.lane, title: 'Ready projection bar', route: 'mid',
    barActor: { session: 'a'.repeat(64), parent: 'a'.repeat(64) }, criterion: 'The projection witness names a mismatch', check,
    checkBaseline: { command: check, main: head, result: 'red', testEvidence: { failed: ['projection witness'], passed: [], noTestsMatched: false } },
    brief: 'Files: src/projection.js\nTest: projection witness asserts mismatch\nNamed test: projection witness\nMeasurements: no quantitative acceptance bounds\nReviewer edges: absent field and clock-only change' });
  const { revision } = barReadiness(board, store.getItem(board, item), {}, board.runtimePorts.verification);
  await exercise('signBar', () => store.signBar(board, item, { agentId: reviewer,
    barActor: { session: 'b'.repeat(64), parent: 'b'.repeat(64) }, revision: revision.revision, digest: revision.digest,
    note: 'Synthetic readiness signature for state projection only.', coverage: { version: 1, sourceMain: head, policyKey: 'd'.repeat(64),
      sourceCheck: check, timeoutMs: 300000, runner: 'node --test', required: [], files: [] } }));
  store.setBarReady(board, { agentId: 'coordinator', enabled: false });
}

/** New declared operations retain unknown proof facts and real cross-lane child state, without fabricated execution claims. */
export async function seedCurrentOperations(context) {
  const { board, box, store, exercise, agent } = context;
  const lead = store.listAgents(board).find(seat => seat.agent_id === agent);
  assert.equal(lead?.agent_lane, box.lane, 'the lane lead is an actual registered seat in this lane');
  requireHandoffActive(board, agent, 'setLaneLead', []);
  await exercise('setLaneLead', () => store.setLaneLead(board, { agentId: 'coordinator', lane: box.lane, seat: agent, lanes: [box.lane] }));
  assert.equal(store.laneLeads(board)[box.lane], agent, 'the native operation records the qualified lane lead');
  await exercise('setLaneLead', () => store.setLaneLead(board, { agentId: 'coordinator', lane: box.lane, seat: null, lanes: [box.lane] }));
  assert.equal(store.laneLeads(board)[box.lane], undefined, 'the native off form clears the same lane policy');
  const item = store.addItem(board, { by: 'coordinator', lane: box.lane, title: 'Synthetic provenance projection', criterion: 'Readers retain unknown receipt facts' });
  const head = resolveCommit(box.root, 'HEAD');
  const tree = tryGit(box.root, ['rev-parse', `${head}^{tree}`]).stdout.trim();
  const receipt = { version: 2, id: randomUUID(), kind: 'check', head, tree, main: null,
    command: 'c'.repeat(64), green: false, failures: [], load: null, at: board.clock.now().toISOString(),
    proof: { item, frozenDigest: null, seat: agent, environment: null, runner: null, exitCode: null,
      counts: { passed: null, failed: null, skipped: null }, durationMs: 0, sourceClean: false } };
  // Exactly as the accepted native storage-boundary fixture, this models a historical record,
  // never evidence that this test ran a gate or observed any executor/counts.
  const folder = join(box.root, '.git', 'pullboard', 'gate-receipts');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${receipt.id}.json`), receiptBody(receipt));
  await exercise('recordProofRun', () => store.recordProofRun(board, { agentId: agent, itemId: item, receiptId: receipt.id }));
  await exercise('requestCompanion', () => store.requestCompanion(board, { agentId: agent, parentId: item,
    lane: box.lane === 'tests' ? 'core' : 'tests', key: 'reader-parity', title: 'Projection companion',
    criterion: 'A real cross-lane child remains visible in both readers', brief: 'Synthetic private board child; no real work requested.' }));
}

/** New signing mutations are projection inputs, never proof of passkey authority or presence [E22,H16]. */
export async function seedPersonSigning(context) {
  const { board, store, exercise, reviewer } = context;
  // The preceding handoff retired the worker; its actual recipient remains an active native actor.
  requireHandoffActive(board, reviewer, 'setPersonSigning', []);
  await exercise('setPersonSigning', () => board.enginePorts.store.setPersonSigning(board, { agentId: reviewer, signed: true }));
  assert.equal(board.enginePorts.store.personSigning(board).signed, true, 'the actual native signing event enables the device projection');
  const request = preparePersonRequest({ verb: 'signing', args: { signed: 'off' } }, randomUUID());
  await exercise('proposePersonMove', () => board.enginePorts.store.proposePersonMove(board, { agentId: reviewer, request }));
  const proposal = board.enginePorts.store.personProposals(board).find(entry => entry.id === request.id);
  assert.ok(proposal, 'the native proposal retains its exact request identity');
  assert.deepEqual(proposal.move, request.move, 'the device projection carries the exact proposed intent');
  assert.equal(board.enginePorts.store.personSigning(board).signed, true, 'a proposal grants no authority to turn signing off');
}

/** Synthetic numeric summaries exercise native projection; no provider execution or measured usage is claimed. */
export async function seedUsage(context) {
  const { board, box, store, exercise, agent, reviewer, item, claim } = context;
  const peerItem = store.addItem(board, { by: 'coordinator', lane: 'tests', title: 'Usage projection peer',
    criterion: 'Shared unknown counters retain their native allocations', check: 'node --test test/projection.test.js' });
  store.claim(board, peerItem, { ...claim, agentId: reviewer, lane: 'tests' });
  const observedAt = board.clock.now().getTime();
  const records = [{ model: 'synthetic-unknown-projection', inputTokens: null, outputTokens: null,
    wallMs: 0, knownInputTokens: 0, knownOutputTokens: 0, unknownReasons: ['native-session-unavailable'] }];
  await exercise('recordUsage', () => store.recordUsage(board, { agentId: agent, item, revision: 1, observedAt, records }));
  const sharedId = randomUUID();
  await exercise('recordSharedUsage', () => store.recordSharedUsage(board, { agentId: agent, id: sharedId,
    seats: [agent, reviewer], allocations: [{ seat: agent, item }, { seat: reviewer, item: peerItem }],
    revision: 1, observedAt, records }));
  const batch = await exercise('recordUsageBatch', () => store.recordUsageBatch(board, { agentId: agent,
    items: [2, 3].map(revision => ({ agentId: agent, item, revision, observedAt: observedAt + revision, records })),
    sharedSessions: [{ id: sharedId, seats: [agent, reviewer],
      allocations: [{ seat: agent, item }, { seat: reviewer, item: peerItem }],
      revision: 2, observedAt: observedAt + 2, records }] }));
  assert.deepEqual(batch, { items: [{ recorded: true }, { recorded: true }], sharedSessions: [{ recorded: true }] },
    'every batch entry advances its existing item or shared-session revision before complete reader parity');
}
