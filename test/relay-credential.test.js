/** Real transport proves credential selection follows every public operation class [H2,H9,H16]. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { ENGINE_OPERATIONS } from '../src/engine.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { decodeBoardKey, unseal } from '../src/seal.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { syntheticFlakeObservation } from './flake-observation-fixture.js';

test('every current operation selects its native actor credential without a second authorization policy [H2,H9,H16]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const actor = 'coordinator';
  const options = { agentId: actor, lane: box.lane, leaseMs: 3600000, reason: 'credential fixture', note: 'credential fixture', text: 'fixture', kind: 'observation', head: 'a'.repeat(40), frozen: { text: '{"rows":[]}', digest: 'f'.repeat(64) } };
  const cases = ENGINE_OPERATIONS.map(operation => {
    let args = [999999, options];
    let kind = 'agent';
    if (operation === 'register') { args = [{ lane: box.lane, path: '/private/credential-enrollment' }]; kind = 'machine'; }
    if (operation === 'ensureCoordinator') { args = [box.root]; kind = 'machine'; }
    if (operation === 'intakeOutside') args = [{ agentId: actor }];
    if (operation === 'openHandoff') args = [{ agentId: actor }];
    if (operation === 'takeHandoff') args = [{ agentId: actor, item: 999999 }];
    if (operation === 'approveOutside') { args = [999999, { agentId: 'person' }]; kind = 'person'; }
    if (operation === 'addItem') args = [{ by: actor, lane: box.lane, title: 'credential actor fixture' }];
    if (operation === 'shout') args = [{ from: actor, to: 'all', text: 'credential actor fixture', lanes: [box.lane] }];
    if (operation === 'release') args = [999999, actor];
    if (['claim', 'refreeze'].includes(operation)) args = [box.before.tables.item[0].item_id, options];
    if (operation === 'reserveNextReview') args = [options];
    if (operation === 'setLineSetting') args = [{ agentId: actor, key: 'reviewsFirst', value: true, reason: 'credential fixture', window: { windowMinutes: 60, activeReviewers: 1 } }];
    if (operation === 'setBoardMembers') args = [{ agentId: actor, document: null }]; // Native format refusal still exercises the authenticated credential.
    if (operation === 'setBarReady') args = [{ agentId: actor, enabled: false }];
    if (operation === 'recordHealthFindings') args = [{ agentId: actor, observedRevision: 0, findings: [] }];
    if (operation === 'recordActivityDelivery') args = [{ agentId: actor, through: 0, interrupts: [] }];
    if (operation === 'actOnActivity') args = [{ agentId: actor, ids: ['event:1'] }];
    if (operation === 'recordSpecApprovalBaseline') args = [{ agentId: actor, baseline: { version: 1, file: 'SPEC.md', anchor: null, rows: [] } }];
    if (operation === 'recordRowVerification') args = [{ agentId: actor, source: '- G1 [approved, must] A credential fixture row. | gate: review', decision: 'accepted', reason: 'credential fixture' }];
    if (operation === 'recordFlakeObservation') args = [{ agentId: actor, lane: box.lane, observation: syntheticFlakeObservation('credential-fixture') }];
    if (operation === 'recordGateRun') args = [{ agentId: actor, lane: box.lane, receipt: { version: 1, id: '00000000-0000-4000-8000-00000000c0de', kind: 'gate', tree: 'b'.repeat(40), head: 'a'.repeat(40),
      main: 'a'.repeat(40), command: 'c'.repeat(64), green: true, failures: [], load: { average: [0, 0, 0], cpus: 1, freeMB: 100 }, at: '2026-10-20T00:00:00.000Z' } }];
    if (operation === 'declareJob') args = [{ agentId: actor, name: 'credential-job', every: '10m', owner: actor }];
    if (operation === 'recordJobRun') args = [{ agentId: actor, name: 'credential-job' }];
    if (operation === 'takeCoordinator') args = [{ agentId: actor, machine: 'credential-machine' }];
    if (operation === 'landingLeaseMove') args = [{ agentId: actor, action: 'renew', token: 'credential-lease', branch: 'main', pid: 1, generation: 0 }];
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
    // This missing-item fixture still supplies modern proof metadata before testing submit's transport credential.
    if (operation === 'submit') args = [999999, { ...options, submissionProof: { version: 1, files: [], full: false, deferred: false, reason: '' } }];
    if (operation === 'completeCheckBaseline') args = [999999, { ...options,
      expected: { command: 'true', main: 'a'.repeat(40), result: 'pending', request: '11111111-1111-4111-8111-111111111111' },
      baseline: { command: 'true', main: 'a'.repeat(40), result: 'green' },
    }];
    if (['recordLandingBatch', 'recordLandingFlake', 'recordLandingTestDefect', 'finishLandingBatch'].includes(operation)) args = [options];
    if (operation === 'recordLandingWaiver') { args = [{ ...options, agentId: 'person', channel: 'terminal' }]; kind = 'person'; }
    if (operation === 'addMilestone') args = [{ agentId: actor, name: 'Credential fixture', items: [] }];
    if (['holdLane', 'releaseLane'].includes(operation)) args = [box.lane, options];
    if (operation === 'applyRowDecisions') args = [{ agentId: actor, events: [] }];
    if (operation === 'draftSpecRow') args = [{ agentId: actor, row: { id: 'G9', text: 'A credential fixture row.', gate: 'review', tier: 'must', section: 'G · Goals' } }];
    if (operation === 'recordRowDecisions') { args = [{ agentId: 'person', channel: 'terminal', decisions: [] }]; kind = 'person'; }
    if (operation === 'decideSpecRevisions') { args = [{ agentId: 'person', channel: 'terminal', decisions: [] }]; kind = 'person'; }
    // A gate run with no receipt from this machine's own gate is refused before it reaches transport.
    if (operation === 'recordGateRun') return { operation, args, kind, sent: false, expected: 'GATE_RUN_UNBOUND' };
    return { operation, args, kind, ...(kind === 'person' ? { sent: false } : {}) };
  });
  cases.push(
    { operation: 'openHandoff', args: [{}], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'takeHandoff', args: [{ item: 999999 }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordPublishFinding', args: [{ item: 999999 }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordHealthFindings', args: [{ observedRevision: 0, findings: [] }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'setBoardMembers', args: [{ document: null }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordActivityDelivery', args: [{ through: 0, interrupts: [] }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'actOnActivity', args: [{ ids: ['event:1'] }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordSpecApprovalBaseline', args: [{ baseline: { version: 1, file: 'SPEC.md', anchor: null, rows: [] } }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordRowVerification', args: [{ source: '- G1 [approved, must] A credential fixture row. | gate: review', decision: 'accepted', reason: 'credential fixture' }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordFlakeObservation', args: [{ lane: box.lane, observation: syntheticFlakeObservation('missing-actor') }], kind: 'agent', sent: false, expected: 'RELAY_ACTOR' },
    { operation: 'recordGateRun', args: [{ lane: box.lane, receipt: {} }], kind: 'agent', sent: false, expected: 'GATE_RUN_EVIDENCE' },
    { operation: 'submit', args: [999999, options], kind: 'agent', sent: false, expected: 'SUBMISSION_PROOF' },
    { operation: 'answerDecision', args: [999999, { ...options, asPerson: true, channel: 'terminal' }], kind: 'person', sent: false },
    { operation: 'holdLane', args: [box.lane, { ...options, asPerson: true, channel: 'terminal' }], kind: 'person', sent: false },
    { operation: 'releaseLane', args: [box.lane, { ...options, asPerson: true, channel: 'terminal' }], kind: 'person', sent: false },
    { operation: 'shout', args: [{ from: actor, to: 'all', text: 'person request fixture', lanes: [box.lane], request: true }], kind: 'person', sent: false },
    { operation: 'applyRowDecisions', args: [{ agentId: actor, events: [] }], kind: 'machine', sent: false, expected: 'PERSON_REQUEST_CLOSED', personRequest: { id: 'credential-request', executor: actor, phase: 'execute', digest: '0'.repeat(64) } },
  );
  const start = box.moveAcks.length;
  const results = [];
  // Each child keeps the fixture's existing deadline while all moves share one durable board.
  for (let offset = 0; offset < cases.length; offset += 8) {
    const batch = cases.slice(offset, offset + 8);
    const result = await box.script(`
    import { relayOperation } from ${JSON.stringify(new URL('../src/relay.js', import.meta.url).href)};
    import { Refused } from ${JSON.stringify(new URL('../src/refused.js', import.meta.url).href)};
    const cases = ${JSON.stringify(batch)};
    const results = [];
    for (const entry of cases) {
      const io = { err() {}, onEvent() {}, ...(entry.personRequest ? { personRequest: entry.personRequest } : {}) };
      try { await relayOperation(process.cwd(), entry.operation, entry.args, io); results.push(null); }
      catch (error) { if (!(error instanceof Refused)) { results.push({ fatal: error.name, operation: entry.operation, stack: error.stack?.split('\\n').slice(1, 3).join('\\n') }); break; } results.push(error.code); }
    }
    console.log(JSON.stringify({ results }));
  `);
    assert.equal(result.code, 0, 'every operation reaches the real transport and deterministic replay');
    assert.equal(result.document.results.some(value => value?.fatal), false, JSON.stringify(result.document.results.filter(value => value?.fatal)));
    assert.equal(result.document.results.length, batch.length);
    results.push(...result.document.results);
  }
  const records = box.moveAcks.slice(start);
  const sentCases = cases.filter(entry => entry.sent !== false);
  assert.equal(records.length, sentCases.length, 'valid agent and machine moves are acknowledged; invalid and person-only moves stop before transport');
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  let recordIndex = 0;
  for (const [index, entry] of cases.entries()) {
    if (entry.sent === false) {
      assert.equal(results[index], entry.expected ?? 'HUMAN_REQUIRED', `${entry.operation} retains its exact refusal before transport`);
      continue;
    }
    const record = records[recordIndex++];
    const move = JSON.parse(new TextDecoder().decode(await unseal(key, Buffer.from(record.sealed, 'base64url'), { boardId: state.board, kind: record.kind, sequence: record.event_id })));
    assert.equal(move.operation, entry.operation);
    assert.equal(move.engine, ENGINE_VERSION, 'the current engine version is recorded on every sealed operation');
    assert.equal(record.sender.kind, entry.kind, `${entry.operation} selects the correct authenticated credential`);
    if (entry.kind === 'agent') assert.equal(record.sender.agent, actor, 'the scoped credential belongs to the native actor');
    if (entry.kind === 'machine') assert.equal(record.sender.machine, state.machine, 'the machine credential is attributed to this native machine');
    if (entry.personRequest) {
      assert.equal(results[index], 'RELAY_PERSON_ONLY', 'a machine cannot execute an unauthenticated synthetic person request');
    } else {
      assert.ok(!['RELAY_ACTOR', 'RELAY_SENDER', 'RELAY_SENDER_MISMATCH', 'RELAY_PERSON_ONLY'].includes(results[index]),
        `${entry.operation} passes main's shared sender policy`);
    }
  }
});

test('a person-only move is refused before the relay is asked [H2,H9,H16]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();

  /** Return one move's relay-call trace from the real linked CLI environment. */
  async function orderedMove(operation, args, io = {}) {
    return box.script(`
      import { relayOperation } from ${JSON.stringify(new URL('../src/relay.js', import.meta.url).href)};
      const io = ${JSON.stringify(io)};
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
  const personResult = await box.script(`
    import { relayOperation } from ${JSON.stringify(new URL('../src/relay.js', import.meta.url).href)};
    const cases = ${JSON.stringify(personCases)};
    const results = [];
    for (const [operation, args] of cases) {
      try { await relayOperation(process.cwd(), operation, args, { err() {} }); results.push(null); }
      catch (error) { results.push(error.code ?? error.name); }
    }
    console.log(JSON.stringify({ results }));
  `);
  assert.equal(personResult.code, 0, 'the real private CLI environment runs every person-only operation');
  assert.deepEqual(personResult.document.results, personCases.map(() => 'HUMAN_REQUIRED'),
    `each person-only action is refused before asking an unreachable relay; observed requests: ${JSON.stringify(arrivals)}`);
  assert.deepEqual(arrivals, [], 'no person-only operation reaches the relay');
});
