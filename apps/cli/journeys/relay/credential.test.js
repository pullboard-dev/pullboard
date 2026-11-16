/** Real transport proves credential selection follows every public operation class [H2,H9,H16]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import {
  delimiter,
  join,
} from 'node:path';
import { test } from 'node:test';
import { MOVE_OPERATIONS as ENGINE_OPERATIONS } from '../../../../packages/moves/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import {
  decodeBoardKey,
  unseal,
} from '../../../../packages/kernel/index.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { syntheticFlakeObservation } from '../../tests/fixtures/observation.js';

/** How many linked boards share the operations: each runs its own relay and child process, so their moves overlap. */
const BOARDS = 3;
/** Operations bound to the claimed row; they keep one board and their order so the earlier claim still owns it. */
const ITEM_BOUND = ['claim', 'refreeze', 'attachItemPatch', 'removeItemPatch', 'followItemPatches'];

/** A linked board whose CLI is on PATH and whose relay policy fixture is committed. */
async function linkedBox(t) {
  const box = await relayClientFixture(t);
  await box.link();
  symlinkSync(new URL('../../pullboard.js', import.meta.url), join(box.env.PATH.split(delimiter)[0], 'pullboard'));
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env, stdio: 'pipe' });
  runFixtureGit(['commit', '-q', '-m', 'chore(test): commit relay policy fixture', '--', 'pullboard.json'], {
    cwd: box.root, env: box.env, stdio: 'pipe',
  });
  return box;
}

/** Every public operation's case against one board, in engine order: the arguments, the credential kind and the expected refusal if any. */
function credentialCases(box) {
  const actor = 'coordinator';
  assert.equal(box.before.tables.item[0].item_status, 'open', 'the first follow control starts with a genuinely unclaimed row');
  assert.ok(ENGINE_OPERATIONS.indexOf('claim') < ENGINE_OPERATIONS.indexOf('followItemPatches'), 'the later source-fence control follows the actual claim operation');
  const options = { agentId: actor, lane: box.lane, leaseMs: 3600000, reason: 'credential fixture', note: 'credential fixture', text: 'fixture', kind: 'observation', head: 'a'.repeat(40), frozen: { text: '{"rows":[]}', digest: 'f'.repeat(64) } };
  const cases = ENGINE_OPERATIONS.map(operation => {
    let args = [999999, options];
    let kind = 'agent';
    if (operation === 'register') { args = [{ lane: box.lane, path: '/private/credential-enrollment' }]; kind = 'machine'; }
    if (operation === 'ensureCoordinator') { args = [box.root]; kind = 'machine'; }
    if (operation === 'intakeOutside') args = [{ agentId: actor }];
    if (operation === 'openHandoff') args = [{ agentId: actor }];
    if (['recordUsage', 'recordSharedUsage', 'recordUsageBatch', 'recordCoordinatorUsage'].includes(operation)) args = [{ agentId: actor }];
    if (operation === 'recordExitProgress') args = [{ agentId: actor, item: 999999,
      claim: '00000000-0000-4000-8000-00000000c0de', tokens: null, calls: null }];
    if (operation === 'takeHandoff') args = [{ agentId: actor, item: 999999 }];
    if (operation === 'approveOutside') { args = [999999, { agentId: 'person' }]; kind = 'person'; }
    if (operation === 'addItem') args = [{ by: actor, lane: box.lane, title: 'credential actor fixture' }];
    if (operation === 'requestCompanion') args = [{ agentId: actor, parentId: 999999, lane: box.lane,
      key: 'credential-companion', title: 'credential actor fixture' }];
    if (operation === 'createItemSlice') args = [{ agentId: actor, parentId: 999999,
      parentDigest: 'f'.repeat(64), title: 'credential slice fixture', lane: box.lane, files: ['src/credential-fixture.js'] }];
    if (operation === 'shout') args = [{ from: actor, to: 'all', text: 'credential actor fixture', lanes: [box.lane] }];
    if (operation === 'release') args = [999999, actor];
    // State-bound companion sealing reads the real item before choosing its replay protocol.
    if (['claim', 'refreeze', 'attachItemPatch', 'removeItemPatch', 'followItemPatches'].includes(operation)) args = [box.before.tables.item[0].item_id, options];
    if (operation === 'reserveNextReview') args = [options];
    if (operation === 'reserveRehomeItemId') args = ['a'.repeat(32), 'credential-rehome-reservation', { agentId: actor }];
    if (operation === 'setLineSetting') args = [{ agentId: actor, key: 'reviewsFirst', value: true, reason: 'credential fixture', window: { windowMinutes: 60, activeReviewers: 1 } }];
    if (operation === 'setLaneLead') args = [{ agentId: actor, lane: box.lane, seat: null, lanes: [box.lane] }];
    if (operation === 'fileTypedRequest') args = [{ agentId: actor, verb: 'hold', itemId: 999999, cause: 'routing-assignment', note: 'credential fixture' }];
    if (operation === 'answerTypedRequests') args = [{ agentId: actor, answers: [{ requestId: 999999, outcome: 'declined', note: 'credential fixture' }] }];
    if (operation === 'setBoardMembers') args = [{ agentId: actor, document: null }]; // Native format refusal still exercises the authenticated credential.
    if (operation === 'setBarReady') args = [{ agentId: actor, enabled: false }];
    if (operation === 'maintainStaleState') args = [{ agentId: actor, snapshot: null }];
    if (operation === 'recordHealthFindings') args = [{ agentId: actor, observedRevision: 0, findings: [] }];
    if (operation === 'recordSelectorGap') args = [{ agentId: actor, itemId: box.before.tables.item[0].item_id,
      receiptId: 'missing-selector-gap-review', review: null }];
    if (operation === 'recordNextIdle') args = [{ agentId: actor, reason: 'nothing-eligible' }];
    if (operation === 'recordActivityDelivery') args = [{ agentId: actor, through: 0, interrupts: [] }];
    if (operation === 'actOnActivity') args = [{ agentId: actor, ids: ['event:1'] }];
    if (operation === 'recordSpecApprovalBaseline') args = [{ agentId: actor, baseline: { version: 1, file: 'SPEC.md', anchor: null, rows: [] } }];
    if (operation === 'recordRowVerification') args = [{ agentId: actor, source: '- G1 [approved, must] A credential fixture row. | gate: review', decision: 'accepted', reason: 'credential fixture' }];
    if (operation === 'recordFlakeObservation') args = [{ agentId: actor, lane: box.lane, observation: syntheticFlakeObservation('credential-fixture') }];
    if (operation === 'recordGateRun') args = [{ agentId: actor, lane: box.lane, receipt: { version: 1, id: '00000000-0000-4000-8000-00000000c0de', kind: 'gate', tree: 'b'.repeat(40), head: 'a'.repeat(40),
      main: 'a'.repeat(40), command: 'c'.repeat(64), green: true, failures: [], load: { average: [0, 0, 0], cpus: 1, freeMB: 100 }, at: '2026-10-20T00:00:00.000Z' } }];
    if (operation === 'recordProofRun') args = [{ agentId: actor, itemId: 999999, receiptId: '00000000-0000-4000-8000-00000000c0de' }];
    if (operation === 'declareJob') args = [{ agentId: actor, name: 'credential-job', every: '10m', owner: actor }];
    if (operation === 'recordJobRun') args = [{ agentId: actor, name: 'credential-job' }];
    if (operation === 'takeCoordinator') args = [{ agentId: actor, machine: 'credential-machine' }];
    if (operation === 'landingLeaseMove') args = [{ agentId: actor, action: 'renew', token: 'credential-lease', branch: 'main', pid: 1, generation: 0 }];
    if (operation === 'setPersonSigning') args = [{ agentId: actor, signed: true }];
    if (operation === 'proposePersonMove') args = [{ agentId: actor, request: { version: 1, type: 'person-request', id: 'credential-proposal', move: { verb: 'shout', args: { text: 'credential proposal fixture' } } } }];
    if (operation === 'recordPublishFinding') args = [{ agentId: actor, item: 999999, repository: 'fixture/repository',
      pull: 1, head: 'a'.repeat(40), failures: [{ id: 1, name: 'credential fixture',
        url: 'https://github.com/fixture/repository/actions/runs/1', files: ['test/fixture.test.js'] }] }];
    if (operation === 'proposeSentinel') args = [{ agentId: actor,
      row: { name: 'credential-watch', check: 'true', every: 'hourly', owner: actor } }];
    if (['beginSentinelRun', 'finishSentinelRun'].includes(operation)) {
      args = [{ agentId: actor, name: 'credential-watch', digest: 'f'.repeat(64), run: 'credential-run' }];
    }
    if (operation === 'decideSentinel') {
      args = [{ agentId: 'person', channel: 'terminal', name: 'credential-watch', digest: 'f'.repeat(64), decision: 'approve' }];
      kind = 'person';
    }
    // Keep a modern proof payload so this missing item reaches its exact native refusal.
    if (operation === 'submit') return { operation,
      args: [999999, { ...options, submissionProof: { version: 1, files: [], full: false, deferred: false, reason: '' } }],
      kind, sent: false, expected: 'NO_ITEM', label: 'submit with proof for a missing item' };
    if (operation === 'completeCheckBaseline') args = [999999, { ...options,
      expected: { command: 'true', main: 'a'.repeat(40), result: 'pending', request: '11111111-1111-4111-8111-111111111111' },
      baseline: { command: 'true', main: 'a'.repeat(40), result: 'green' },
    }];
    if (['recordLandingBatch', 'recordLandingFlake', 'recordLandingTestDefect', 'finishLandingBatch'].includes(operation)) args = [options];
    // Closing a trunk defect names its actor in its one argument, like recording one.
    if (operation === 'closeLandingTestDefect') args = [{ agentId: actor, branch: 'main', test: 'test/credential-fixture.test.js',
      item: 999999, commit: 'a'.repeat(40) }];
    if (operation === 'recordLandingWaiver') { args = [{ ...options, agentId: 'person', channel: 'terminal' }]; kind = 'person'; }
    if (operation === 'addMilestone') args = [{ agentId: actor, name: 'Credential fixture', items: [] }];
    if (['holdLane', 'releaseLane'].includes(operation)) args = [box.lane, options];
    if (operation === 'applyRowDecisions') args = [{ agentId: actor, events: [] }];
    if (operation === 'draftSpecRow') args = [{ agentId: actor, row: { id: 'G9', text: 'A credential fixture row.', gate: 'review', tier: 'must', section: 'G · Goals' } }];
    if (operation === 'recordRowDecisions') { args = [{ agentId: 'person', channel: 'terminal', decisions: [] }]; kind = 'person'; }
    if (operation === 'decideSpecRevisions') { args = [{ agentId: 'person', channel: 'terminal', decisions: [] }]; kind = 'person'; }
    // A gate run with no receipt from this machine's own gate is refused before it reaches transport.
    // An automatic source advance, like a gate receipt, requires private native origin custody before transport.
    // A queue without an immutable captured job is refused by the genuine origin sealer before transport.
    if (operation === 'queueSubmitHandoff') return { operation, args, kind, sent: false, expected: 'BAD_SUBMIT_HANDOFF' };
    if (operation === 'advanceItemSource') return { operation, args, kind, sent: false, expected: 'SOURCE_ADVANCE_STALE' };
    // An owner wait seals its proved source natively, so a missing item stops at that preparation before transport.
    if (operation === 'deferOwnership') return { operation, args, kind, sent: false, expected: 'NO_ITEM' };
    // The earlier claim case now owns this row; a non-HEAD source must stop at native origin sealing.
    if (operation === 'followItemPatches') return { operation, args: [box.before.tables.item[0].item_id, { agentId: actor, commit: '0'.repeat(40) }],
      kind, sent: false, expected: 'ITEM_PATCH_SOURCE', label: 'followItemPatches claimed row with invalid head' };
    if (operation === 'recordTrainLanding') return { operation, args: [{ agentId: 'coordinator',
      batch: { root: box.root, items: [{ id: 999999 }], tip: 'a'.repeat(40) } }], kind, sent: false, expected: 'LAND_RECEIPT_REQUIRED' };
    if (operation === 'recordProofRun') return { operation, args, kind, sent: false, expected: 'PROOF_RUN_UNBOUND' };
    if (operation === 'recordGateRun') return { operation, args, kind, sent: false, expected: 'GATE_RUN_UNBOUND' };
    if (operation === 'recordSelectorGap') return { operation, args, kind, expectedResult: 'SELECTOR_GAP_UNPROVED',
      label: 'recordSelectorGap without an actual reviewed-failure receipt' };
    return { operation, args, kind, ...(kind === 'person' ? { sent: false } : {}) };
  });
  cases.unshift({ operation: 'followItemPatches', args: [box.before.tables.item[0].item_id, { agentId: actor, commit: '0'.repeat(40) }],
    kind: 'agent', sent: false, expected: 'NOT_YOURS', label: 'followItemPatches initial unclaimed row' });
  cases.push(
    { operation: 'recordTrainLanding', args: [{}, { agentId: actor }], kind: 'agent', sent: false, expected: 'COORDINATOR_ONLY' },
    // Native preparation checks claim authority before actorTransport; no implicit actor is supplied.
    { operation: 'followItemPatches', args: [box.before.tables.item[0].item_id, { commit: '0'.repeat(40) }],
      kind: 'agent', sent: false, expected: 'NOT_YOURS', label: 'followItemPatches missing actor' },
    { operation: 'fileTypedRequest', args: [{ verb: 'hold', itemId: 999999, cause: 'routing-assignment' }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'answerTypedRequests', args: [{ answers: [{ requestId: 999999, outcome: 'declined', note: 'missing actor' }] }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'requestCompanion', args: [{ parentId: 999999, lane: box.lane, key: 'missing-actor', title: 'Missing actor' }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'openHandoff', args: [{}], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordUsage', args: [{}], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordSharedUsage', args: [{}], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordCoordinatorUsage', args: [{}], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'takeHandoff', args: [{ item: 999999 }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordPublishFinding', args: [{ item: 999999 }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'maintainStaleState', args: [{ snapshot: null }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordHealthFindings', args: [{ observedRevision: 0, findings: [] }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'setBoardMembers', args: [{ document: null }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordNextIdle', args: [{ reason: 'nothing-eligible' }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordActivityDelivery', args: [{ through: 0, interrupts: [] }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordSelectorGap', args: [{ itemId: box.before.tables.item[0].item_id, receiptId: 'missing-selector-gap-review', review: null }],
      kind: 'agent', sent: false, expected: 'RELAY_ACTOR', label: 'recordSelectorGap missing actor' },
    { operation: 'actOnActivity', args: [{ ids: ['event:1'] }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordSpecApprovalBaseline', args: [{ baseline: { version: 1, file: 'SPEC.md', anchor: null, rows: [] } }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordRowVerification', args: [{ source: '- G1 [approved, must] A credential fixture row. | gate: review', decision: 'accepted', reason: 'credential fixture' }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordFlakeObservation', args: [{ lane: box.lane, observation: syntheticFlakeObservation('missing-actor') }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordGateRun', args: [{ lane: box.lane, receipt: {} }], kind: 'agent', sent: false, expected: 'GATE_RUN_EVIDENCE' },
    { operation: 'submit', args: [box.before.tables.item[0].item_id, options], kind: 'agent', sent: false, expected: 'SUBMISSION_PROOF' },
    { operation: 'answerDecision', args: [999999, { ...options, asPerson: true, channel: 'terminal' }], kind: 'person', sent: false },
    { operation: 'holdLane', args: [box.lane, { ...options, asPerson: true, channel: 'terminal' }], kind: 'person', sent: false },
    { operation: 'releaseLane', args: [box.lane, { ...options, asPerson: true, channel: 'terminal' }], kind: 'person', sent: false },
    { operation: 'shout', args: [{ from: actor, to: 'all', text: 'person request fixture', lanes: [box.lane], request: true }], kind: 'person', sent: false },
    { operation: 'applyRowDecisions', args: [{ agentId: actor, events: [] }], kind: 'machine', sent: false, expected: 'PERSON_REQUEST_CLOSED', personRequest: { id: 'credential-request', executor: actor, phase: 'execute', digest: '0'.repeat(64) } },
  );
  return cases;
}


test('every current operation selects its native actor credential without a second authorization policy [H2,H9,H16]', async (t) => {
  const actor = 'coordinator';
  const boxes = await Promise.all(Array.from({ length: BOARDS }, () => linkedBox(t)));
  const [first] = boxes;
  assert.equal(first.before.tables.item[0].item_status, 'open', 'the first follow control starts with a genuinely unclaimed row');
  assert.ok(ENGINE_OPERATIONS.indexOf('claim') < ENGINE_OPERATIONS.indexOf('followItemPatches'), 'the later source-fence control follows the actual claim operation');
  // Every board builds the same list; each case runs on exactly one board, so all moves still go through the real transport.
  const cases = credentialCases(first);
  const owner = cases.map(entry => ITEM_BOUND.includes(entry.operation) ? 0 : null);
  // The claimed-row board takes fewer of the rest, so every board holds about the same number of moves.
  const share = Math.ceil(cases.length / BOARDS);
  let board = 0, filled = owner.filter(value => value === 0).length;
  for (const [index, value] of owner.entries()) {
    if (value !== null) continue;
    if (filled >= share && board < BOARDS - 1) { board += 1; filled = 0; }
    owner[index] = board;
    filled += 1;
  }
  const results = new Array(cases.length);
  const acknowledgedBy = boxes.map(() => []);
  await Promise.all(boxes.map(async (box, boxIndex) => {
    const mine = credentialCases(box).map((entry, index) => ({ entry, index })).filter(({ index }) => owner[index] === boxIndex);
    const start = box.moveAcks.length;
    // Each child keeps the fixture's existing deadline while all of a board's moves share one durable board.
    for (let offset = 0; offset < mine.length; offset += 8) {
      const batch = mine.slice(offset, offset + 8);
      const result = await box.script(`
    import { relayOperation } from ${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)};
    import { apiBoardOpeners } from ${JSON.stringify(new URL('../../tests/fixtures/board.js', import.meta.url).href)};
    import { Refused } from ${JSON.stringify(new URL('../../../../packages/kernel/src/logic/refused.js', import.meta.url).href)};
    const cases = ${JSON.stringify(batch.map(({ entry }) => entry))};
    const results = [];
    for (const entry of cases) {
      // The checkpoint upload is not an operation class under test; the run-tests setting would publish it inside every move.
      const io = { ...apiBoardOpeners, checkpointInBackground: () => true, scheduleCheckpoint() {}, err() {}, onEvent() {}, ...(entry.personRequest ? { personRequest: entry.personRequest } : {}) };
      try { await relayOperation(process.cwd(), entry.operation, entry.args, io); results.push(null); }
      catch (error) { if (!(error instanceof Refused)) { results.push({ fatal: error.name, operation: entry.operation, stack: error.stack?.split('\\n').slice(1, 3).join('\\n') }); break; } results.push(error.code); }
    }
    console.log(JSON.stringify({ results }));
  `);
      assert.equal(result.code, 0, 'every operation reaches the real transport and deterministic replay');
      assert.equal(result.document.results.some(value => value?.fatal), false, JSON.stringify(result.document.results.filter(value => value?.fatal)));
      assert.equal(result.document.results.length, batch.length);
      batch.forEach(({ entry, index }, position) => {
        results[index] = { operation: entry.operation, label: entry.label ?? entry.operation, expectedSent: entry.sent !== false, result: result.document.results[position] };
      });
    }
    const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
    const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
    for (const record of box.moveAcks.slice(start)) {
      const move = JSON.parse(new TextDecoder().decode(await unseal(key, Buffer.from(record.sealed, 'base64url'), { boardId: state.board, kind: record.kind, sequence: record.event_id })));
      acknowledgedBy[boxIndex].push({ record, move, machine: state.machine });
    }
  }));
  for (const [boxIndex, box] of boxes.entries()) {
    const sentCases = credentialCases(box).filter((entry, index) => owner[index] === boxIndex && entry.sent !== false);
    const acknowledged = acknowledgedBy[boxIndex];
    const expectedOperations = sentCases.map(entry => entry.operation);
    const actualOperations = acknowledged.map(({ move }) => move.operation);
    const mismatch = expectedOperations.findIndex((operation, index) => actualOperations[index] !== operation);
    if (mismatch !== -1 || actualOperations.length !== expectedOperations.length) {
      const start = Math.max(0, (mismatch === -1 ? Math.min(actualOperations.length, expectedOperations.length) : mismatch) - 2);
      assert.fail(`transport acknowledgement sequence differs near ${JSON.stringify({
        board: boxIndex, expected: expectedOperations.slice(start, start + 5), actual: actualOperations.slice(start, start + 5),
        results: results.filter((entry, index) => owner[index] === boxIndex).map(entry => [entry.operation, entry.result]),
      })}`);
    }
    assert.equal(acknowledged.length, sentCases.length, 'valid agent and machine moves are acknowledged; invalid and person-only moves stop before transport');
  }
  const next = boxes.map(() => 0);
  for (const [index, entry] of cases.entries()) {
    if (entry.expectedResult) assert.equal(results[index].result, entry.expectedResult, `${entry.label ?? entry.operation} retains its native outcome after authenticated transport`);
    if (entry.sent === false) {
      assert.equal(results[index].result, entry.expected ?? 'HUMAN_REQUIRED', `${entry.label ?? entry.operation} retains its exact refusal before transport`);
      continue;
    }
    const { record, move, machine } = acknowledgedBy[owner[index]][next[owner[index]]++];
    assert.equal(move.operation, entry.operation);
    assert.equal(move.engine, ENGINE_VERSION, 'the current engine version is recorded on every sealed operation');
    assert.equal(record.sender.kind, entry.kind, `${entry.operation} selects the correct authenticated credential`);
    if (entry.kind === 'agent') assert.equal(record.sender.agent, actor, 'the scoped credential belongs to the native actor');
    if (entry.kind === 'machine') assert.equal(record.sender.machine, machine, 'the machine credential is attributed to this native machine');
    if (entry.personRequest) {
      assert.equal(results[index].result, 'RELAY_PERSON_ONLY', 'a machine cannot execute an unauthenticated synthetic person request');
    } else {
      assert.ok(!['RELAY_ACTOR', 'RELAY_SENDER', 'RELAY_SENDER_MISMATCH', 'RELAY_PERSON_ONLY'].includes(results[index].result),
        `${entry.operation} passes main's shared sender policy`);
    }
  }
});


test('a person-only move is refused before the relay is asked [H2,H9,H16]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();

  /** Return one move's relay-call trace from the real linked CLI environment. */
  async function orderedMove(operation, args, io = {}) {
    return box.scriptLocal(`
      import { relayOperation } from ${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)};
    import { apiBoardOpeners } from ${JSON.stringify(new URL('../../tests/fixtures/board.js', import.meta.url).href)};
      const io = ${JSON.stringify(io)};
      Object.assign(io, apiBoardOpeners);
      io.err = () => {};
      try { await relayOperation(process.cwd(), ${JSON.stringify(operation)}, ${JSON.stringify(args)}, io); console.log(JSON.stringify({ code: null })); }
      catch (error) { console.log(JSON.stringify({ code: error.code ?? error.name })); }
    `);
  }

  const orderedCases = [
    ['register', [{ lane: box.lane, path: '/private/person-refusal-machine-control' }], {}, null],
    ['addItem', [{ by: 'coordinator', lane: box.lane, title: 'person refusal agent control' }], {}, null],
    ['applyRowDecisions', [{ agentId: 'coordinator', events: [] }], {
      personRequest: { id: 'closed-person-request', executor: 'coordinator', phase: 'execute', digest: '0'.repeat(64) },
    }, 'PERSON_REQUEST_CLOSED'],
  ];
  for (const [operation, args, io, expected] of orderedCases) {
    const before = box.calls.length;
    const result = await orderedMove(operation, args, io);
    assert.equal(result.code, 0, `${operation} control runs in the real linked fixture`);
    assert.equal(result.document.code, expected, `${operation} retains its native outcome`);
    const calls = box.calls.slice(before);
    const catchUp = calls.findIndex(call => call.method === 'GET' && call.path.includes('/events?after='));
    assert.notEqual(catchUp, -1, `${operation} reads the relay event prefix before its outcome`);
    if (operation !== 'applyRowDecisions') {
      const move = calls.findIndex(call => call.method === 'POST' && call.path.endsWith('/moves'));
      assert.ok(move > catchUp, `${operation} catches up before sending its move`);
    } else {
      assert.ok(calls.some(call => call.method === 'GET' && call.path.includes('/events?after=')),
        'a person-request execution still follows the machine catch-up path');
    }
  }

  const arrivals = [];
  const blackhole = createServer(request => {
    arrivals.push({ method: request.method, path: request.url });
    request.resume();
    // Deliberately never answer; closing the socket makes a broken guard fail promptly.
    request.socket.destroy();
  });
  t.after(() => {
    blackhole.closeAllConnections();
    blackhole.close();
  });
  await new Promise(resolve => blackhole.listen(0, '127.0.0.1', resolve));
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  state.url = `http://127.0.0.1:${blackhole.address().port}`;
  writeFileSync(box.linkFile, JSON.stringify(state), { mode: 0o600 });

  const personCases = [
    ['addItem', [{ by: 'coordinator', lane: box.lane, title: 'Person-authored bar', barActor: { authority: 'person', session: null, parent: null } }]],
    ['editItem', [1, { agentId: 'coordinator', brief: 'Person correction', barActor: { authority: 'person', session: null, parent: null } }]],
    ['signBar', [1, { agentId: 'coordinator', barActor: { authority: 'person', session: null, parent: null } }]],
    ['recordLandingWaiver', [{ agentId: 'person', channel: 'terminal', reason: 'fixture' }]],
    ['recordRowDecisions', [{ agentId: 'person', channel: 'terminal', decisions: [] }]],
    ['answerDecision', [1, { agentId: 'person', asPerson: true, channel: 'terminal' }]],
    ['holdLane', [box.lane, { agentId: 'person', asPerson: true, channel: 'terminal', reason: 'fixture' }]],
    ['releaseLane', [box.lane, { agentId: 'person', asPerson: true, channel: 'terminal' }]],
    ['shout', [{ from: 'coordinator', to: 'all', text: 'person request fixture', lanes: [box.lane], request: true }]],
  ];
  const personResult = await box.scriptLocal(`
    import { relayOperation } from ${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)};
    import { apiBoardOpeners } from ${JSON.stringify(new URL('../../tests/fixtures/board.js', import.meta.url).href)};
    const cases = ${JSON.stringify(personCases)};
    const results = [];
    for (const [operation, args] of cases) {
      try { await relayOperation(process.cwd(), operation, args, { ...apiBoardOpeners, err() {} }); results.push(null); }
      catch (error) { results.push(error.code ?? error.name); }
    }
    console.log(JSON.stringify({ results }));
  `);
  assert.equal(personResult.code, 0, 'the real private CLI environment runs every person-only operation');
  assert.deepEqual(personResult.document.results, personCases.map(() => 'HUMAN_REQUIRED'),
    `each person-only action is refused before asking an unreachable relay; observed requests: ${JSON.stringify(arrivals)}`);
  assert.deepEqual(arrivals, [], 'no person-only operation reaches the relay');
});
