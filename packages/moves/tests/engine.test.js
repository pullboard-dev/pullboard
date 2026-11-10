/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/state/src/io/engine.js packages/state/src/io/machine.js */
/** In-memory SQLite tests for the deterministic, sequence-ordered move engine [H3,H16]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as store from '../../store/index.js';
import { fixtureBoard } from '../../../apps/cli/tests/fixtures/board.js';
import { submitFixture } from '../../../apps/cli/tests/fixtures/board/submit.js';
import { exportBoard } from '../../store/index.js';
import { importBoard } from '../../store/index.js';
import { restoreRelaySnapshot } from '../../store/index.js';
import { applyEngineMove } from '../../state/index.js';
import { applyRelayMove } from '../../state/index.js';
import { prepareEngineMove } from '../../state/index.js';
import { appliedSequence } from '../../state/index.js';
import { engineReceipt } from '../../state/index.js';
import { refuseRelayMove } from '../../state/index.js';
import { startRelayEpoch } from '../../state/index.js';
import { checkpointSequence } from '../../state/index.js';
import { MOVE_OPERATIONS as ENGINE_OPERATIONS } from '../index.js';
import { COMMAND_CANDIDATE } from '../../kernel/index.js';
import { COMMAND_FILE } from '../../kernel/index.js';
import { discovered } from '../../kernel/index.js';
import { ENGINE_REGISTRY } from '../../state/index.js';
import { ENGINE_VERSION } from '../../state/index.js';
import { discoverEngines } from '../../state/index.js';
import { Refused } from '../../kernel/light.js';
import { unpackRelease } from '../../../apps/cli/tests/fixtures/release/archive.js';

const HOUR = 3_600_000;
const CLAIM_AT = '2026-10-07T18:00:00.000Z';

/** Open two independent SQLite copies of the same registered board and one available item. */
function engineCopies(t, initialize = () => {}, seedEngine = ENGINE_VERSION) {
  const source = fixtureBoard(t);
  // A historical move needs the actual historical join prefix, not a current writer's activated grant.
  source.executionEngineVersion = seedEngine;
  store.register(source, { lane: 'coordinator', path: '/source' });
  store.register(source, { lane: 'web', path: '/source/web-1' });
  store.register(source, { lane: 'web', path: '/source/web-2' });
  const item = store.addItem(source, { by: 'coordinator', lane: 'web', title: 'Engine fixture' });
  initialize(source);
  delete source.executionEngineVersion;
  const document = exportBoard(source);
  const copies = [0, 1].map(index => {
    const clock = { now: () => new Date(`2026-10-07T${index + 16}:00:00.000Z`) };
    const board = fixtureBoard(t, { clock });
    importBoard(board, document);
    return board;
  });
  return { source, copies, item };
}

/** Prepare the same allowlisted claim on a clone, including its actor and lease inputs. */
function claimMove(board, item, agentId) {
  return prepareEngineMove(board, 'claim', [item, {
    agentId, lane: 'web', leaseMs: 2 * HOUR, head: 'a'.repeat(40),
    freeze: () => ({ text: '{"rows":[]}', digest: 'f'.repeat(64) }),
  }], { id: `claim-${item}-${agentId}` });
}

/** Read the persisted relay replay cursor, treating a fresh board as sequence zero. */
function replayCursor(board) {
  const row = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'relay_applied_sequence'").get();
  return Number(row?.meta_value ?? 0);
}

/** Snapshot user-visible board rows so refusal tests can distinguish receipts from move effects. */
function boardRows(board, itemId) {
  return {
    item: store.getItem(board, itemId),
    events: store.events(board),
  };
}

test('authenticated relay senders bind every move and refusals preserve replica prefixes [H2,H9,H3,H16]', (t) => {
  const { copies, item } = engineCopies(t);
  const [one, two] = copies;
  const claim = claimMove(one, item, 'web-1');
  const actorlessClaim = { ...claim, id: 'actorless-person-claim' };
  delete actorlessClaim.actor;
  const mismatchedArgs = prepareEngineMove(one, 'claim', [item, { ...claim.args[1], agentId: 'web-2' }], {
    id: 'sealed-actor-mismatch', actor: 'web-1',
  });
  const personalAnswer = prepareEngineMove(one, 'answerDecision', [1, {
    asPerson: true, agentId: 'coordinator', text: 'fixture answer', lanes: ['web'],
  }], { id: 'agent-person-answer' });
  const cases = [
    { move: actorlessClaim, sender: undefined, expected: 'RELAY_SENDER' },
    { move: claim, sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-2' } },
    { move: mismatchedArgs, sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-1' } },
    { move: prepareEngineMove(one, 'register', [{ lane: 'web', path: '/fixture/enroll' }], { id: 'agent-enrollment' }), sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-1' } },
    { move: personalAnswer, sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-1' }, expected: 'RELAY_PERSON_ONLY' },
    { move: prepareEngineMove(one, 'shout', [{ from: 'web-2', agentId: 'web-1', to: 'all', text: 'spoof', lanes: ['web'] }], { id: 'shadowed-shout', actor: 'web-1' }), sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-1' } },
    { move: prepareEngineMove(one, 'addItem', [{ by: 'coordinator', agentId: 'web-1', lane: 'web', title: 'spoof' }], { id: 'shadowed-add', actor: 'web-1' }), sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-1' } },
  ];

  cases.forEach(({ move, sender, expected = 'RELAY_SENDER_MISMATCH' }, index) => {
    const sequence = index + 1;
    for (const board of copies) {
      const before = boardRows(board, item);
      const outcome = applyRelayMove(board, move, { sequence, at: CLAIM_AT, kind: 'move', sender });
      assert.equal(outcome.error?.code, expected, `case ${index + 1} must refuse before native writes`);
      const after = boardRows(board, item);
      assert.deepEqual(after.item, before.item, `case ${index + 1} leaves native item rows unchanged`);
      assert.deepEqual(after.events.slice(0, -1), before.events, `case ${index + 1} preserves every prior event`);
      assert.equal(after.events.length, before.events.length + 1, 'only the mandated refusal event is appended');
      assert.equal(after.events.at(-1).event_kind, 'relay_refused');
      assert.equal(after.events.at(-1).event_by, sender?.kind === 'agent' ? sender.agent : 'relay');
      assert.equal(replayCursor(board), sequence, `case ${index + 1} commits the refusal prefix`);
    }
  });

  const validClaim = { ...claim, id: 'valid-claim-after-refusals' };
  const agent = { kind: 'agent', userId: 'fixture-user', agent: 'web-1' };
  const claimOne = applyRelayMove(one, validClaim, { sequence: cases.length + 1, at: CLAIM_AT, kind: 'move', sender: agent });
  const claimTwo = applyRelayMove(two, validClaim, { sequence: cases.length + 1, at: CLAIM_AT, kind: 'move', sender: agent });
  assert.deepEqual(claimOne, claimTwo);
  assert.equal(store.getItem(one, item).item_owner, 'web-1');

  const shout = prepareEngineMove(one, 'shout', [{ from: 'web-1', to: 'coordinator', text: 'authenticated fixture', lanes: ['web'] }], { id: 'valid-shout-after-refusals' });
  const shoutOne = applyRelayMove(one, shout, { sequence: cases.length + 2, at: CLAIM_AT, kind: 'move', sender: agent });
  const shoutTwo = applyRelayMove(two, shout, { sequence: cases.length + 2, at: CLAIM_AT, kind: 'move', sender: agent });
  assert.deepEqual(shoutOne, shoutTwo);
  assert.deepEqual(boardRows(one, item), boardRows(two, item), 'valid claim and shout replay identically after refusal prefix');
  assert.equal(replayCursor(one), cases.length + 2);
  assert.equal(replayCursor(two), cases.length + 2);
});

test('person sessions delegate native agent moves under the shared sender policy [H2,H9,H16]', (t) => {
  const { copies, item } = engineCopies(t);
  const move = claimMove(copies[0], item, 'web-1');
  delete move.actor;
  const outcomes = copies.map(board => applyRelayMove(board, move, {
    sequence: 1, at: CLAIM_AT, kind: 'move', sender: { kind: 'person', userId: 'fixture-user' },
  }));
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.equal(outcomes[0].error, undefined);
  for (const board of copies) assert.equal(store.getItem(board, item).item_owner, 'web-1');
});

test('authenticated coordinator milestones replay and reject foreign sender identity [H2,H9,H3,H16]', (t) => {
  const { copies, item } = engineCopies(t);
  const [one, two] = copies;
  const move = prepareEngineMove(one, 'addMilestone', [{ agentId: 'coordinator', reason: 'Arrange fixture release', name: 'Fixture milestone', items: [item] }], { id: 'coordinator-milestone', actor: 'coordinator' });
  for (const board of copies) {
    const before = store.milestones(board);
    const refused = applyRelayMove(board, move, { sequence: 1, at: CLAIM_AT, kind: 'move', sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-1' } });
    assert.equal(refused.error?.code, 'RELAY_SENDER_MISMATCH');
    assert.deepEqual(store.milestones(board), before, 'a foreign scoped token cannot change milestone metadata');
  }
  const valid = { ...move, id: 'valid-coordinator-milestone' };
  const sender = { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' };
  const outcomes = copies.map((board) => applyRelayMove(board, valid, { sequence: 2, at: CLAIM_AT, kind: 'move', sender }));
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.equal(outcomes[0].error, undefined, 'the coordinator scoped token binds the native milestone actor');
  assert.deepEqual(store.milestones(one), [{ name: 'Fixture milestone', note: null, items: [item] }]);
  assert.deepEqual(store.milestones(one), store.milestones(two));
  assert.deepEqual(store.events(one), store.events(two));
});

test('person answer channel replays identically on agent and plain replicas [B26,H16]', t => {
  const questions = [];
  const { copies } = engineCopies(t, source => {
    questions.push(...['view', 'terminal', 'legacy'].map(channel => store.shout(source, {
      from: 'coordinator', to: 'person', text: 'Private engine fixture ' + channel,
      decision: true, lanes: ['web'],
    })));
  });
  const [one, two] = copies;
  const markers = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_SHELL'];
  const original = markers.map(name => [name, process.env[name]]);
  try {
    questions.forEach((id, index) => {
      const channel = ['view', 'terminal', undefined][index];
      const move = prepareEngineMove(one, 'answerDecision', [id, {
        agentId: 'coordinator', text: 'Approved private fixture', lanes: ['web'], asPerson: true,
        ...(channel ? { channel } : {}),
      }]);
      for (const name of markers) process.env[name] = 'fixture-agent';
      const agentReceipt = applyEngineMove(one, move, { sequence: index + 1, at: CLAIM_AT });
      for (const name of markers) delete process.env[name];
      const plainReceipt = applyEngineMove(two, move, { sequence: index + 1, at: CLAIM_AT });
      assert.equal(Boolean(agentReceipt.error), false);
      assert.deepEqual(agentReceipt, plainReceipt, 'replica execution ignores sender-shell markers');
      assert.equal(JSON.parse(agentReceipt.events[0].event_detail).channel, channel ?? 'terminal');
    });
    assert.deepEqual(exportBoard(one).tables, exportBoard(two).tables);
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('missing relay senders are refused deterministically without poisoning a later legitimate move id [H2,H16]', t => {
  const { copies, item } = engineCopies(t);
  const [one, two] = copies;
  const move = claimMove(one, item, 'web-1');
  for (const board of copies) {
    const before = store.getItem(board, item);
    const refused = applyRelayMove(board, move, { sequence: 1, at: CLAIM_AT, kind: 'request' });
    assert.equal(refused.error.code, 'RELAY_SENDER');
    assert.match(refused.error.message, /no authenticated sender.*restore attribution/);
    assert.deepEqual(store.getItem(board, item), before);
    assert.equal(appliedSequence(board), 1);
    assert.equal(engineReceipt(board, move.id), null, 'a forged move id cannot reserve a legitimate operation receipt');
    assert.equal(store.events(board).at(-1).event_kind, 'relay_refused');
    assert.equal(store.events(board).at(-1).event_by, 'relay');
    const accepted = applyRelayMove(board, move, { sequence: 2, at: CLAIM_AT, kind: 'move', sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-1' } });
    assert.equal(Boolean(accepted.error), false);
    assert.equal(store.getItem(board, item).item_owner, 'web-1');
    const after = exportBoard(board);
    assert.deepEqual(applyRelayMove(board, move, { sequence: 1, at: CLAIM_AT, kind: 'request' }), refused);
    assert.deepEqual(exportBoard(board), after, 'repeated refusal returns its own receipt without moving the cursor backwards');
  }
  assert.deepEqual(exportBoard(one).tables, exportBoard(two).tables);
});

test('sealed shouts cannot bypass addressee, already answered or person decision rules [H16,B26]', t => {
  const questions = [];
  const { copies } = engineCopies(t, source => {
    const lanes = ['web'];
    questions.push(store.shout(source, { from: 'coordinator', to: 'person', text: 'Person decision', decision: true, lanes }));
    questions.push(store.shout(source, { from: 'coordinator', to: 'web-2', text: 'Another agent decision', decision: true, lanes }));
    const closed = store.shout(source, { from: 'coordinator', to: 'web-1', text: 'Already answered decision', decision: true, lanes });
    store.answerDecision(source, closed, { agentId: 'web-1', text: 'Original answer', lanes });
    questions.push(closed);
    questions.push(store.shout(source, { from: 'web-1', to: 'coordinator', text: 'Needs passing', decision: true, lanes }));
  });
  for (const board of copies) {
    const original = exportBoard(board);
    let sequence = 0;
    for (const sender of [{ kind: 'agent', userId: 'fixture-user', agent: 'web-1' }, { kind: 'person', userId: 'fixture-user' }]) {
      for (const answers of questions.slice(0, 3)) {
        const move = prepareEngineMove(board, 'shout', [{ from: 'web-1', to: 'coordinator', text: 'Bypass attempted', answers, lanes: ['web'] }], { id: 'bypass-' + ++sequence });
        const refused = applyRelayMove(board, move, { sequence, at: CLAIM_AT, kind: 'move', sender });
        assert.equal(refused.error?.code, 'RELAY_ANSWER');
        assert.match(refused.error.next, /pullboard answer.*pullboard pass/);
        assert.deepEqual(exportBoard(board).tables.shout, original.tables.shout);
        assert.deepEqual(exportBoard(board).tables.item, original.tables.item);
      }
    }
    const agentSender = { kind: 'agent', userId: 'fixture-user', agent: 'web-1' };
    for (const [index, expected] of ['NOT_YOUR_DECISION', 'NOT_YOUR_DECISION', 'ALREADY_ANSWERED'].entries()) {
      const move = prepareEngineMove(board, 'answerDecision', [questions[index], { agentId: 'web-1', text: 'Guarded attempt', lanes: ['web'] }], { id: 'answer-' + ++sequence });
      assert.equal(applyRelayMove(board, move, { sequence, at: CLAIM_AT, kind: 'move', sender: agentSender }).error.code, expected);
      assert.deepEqual(exportBoard(board).tables.shout, original.tables.shout);
    }
    assert.deepEqual(store.openDecisions(board, 'person').map(row => row.shout_id), [questions[0]]);
    const permitted = prepareEngineMove(board, 'answerDecision', [questions[0], { agentId: 'coordinator', asPerson: true, text: 'Person answered', lanes: ['web'], channel: 'view' }], { id: 'person-answer' });
    assert.equal(Boolean(applyRelayMove(board, permitted, { sequence: ++sequence, at: CLAIM_AT, kind: 'move', sender: { kind: 'person', userId: 'fixture-user' } }).error), false);
    assert.deepEqual(store.openDecisions(board, 'person'), []);
    const personSender = { kind: 'person', userId: 'fixture-user' };
    const pass = prepareEngineMove(board, 'passDecision', [questions[3], { agentId: 'coordinator', note: 'Needs the person', lanes: ['web'] }], { id: 'guarded-pass' });
    const passed = applyRelayMove(board, pass, { sequence: ++sequence, at: CLAIM_AT, kind: 'move', sender: personSender });
    assert.equal(Boolean(passed.error), false);
    assert.deepEqual(store.openDecisions(board, 'person').map(row => row.shout_id), [passed.result]);
    const response = prepareEngineMove(board, 'answerDecision', [passed.result, { agentId: 'coordinator', asPerson: true, text: 'Passed decision answered', lanes: ['web'] }], { id: 'passed-answer' });
    assert.equal(Boolean(applyRelayMove(board, response, { sequence: ++sequence, at: CLAIM_AT, kind: 'move', sender: personSender }).error), false);
    assert.deepEqual(store.openDecisions(board, 'person'), []);
    assert.deepEqual(store.openDecisions(board, 'coordinator'), []);
    assert.ok(exportBoard(board).tables.shout.some(row => row.shout_answers === questions[3] && row.shout_from === 'person'), 'guarded person answers reach the original asker');
  }
  assert.deepEqual(exportBoard(copies[0]).tables, exportBoard(copies[1]).tables);
});

test('future engine relay records stop before every sender shape without changing a replica [H16]', t => {
  const { copies, item } = engineCopies(t);
  const move = { ...claimMove(copies[0], item, 'web-1'), engine: ENGINE_VERSION + 1 };
  for (const sender of [undefined, {}, { kind: 'person', userId: 'fixture-user' }, { kind: 'agent', userId: 'fixture-user', agent: 'web-2' }]) {
    for (const board of copies) {
      const before = exportBoard(board);
      assert.throws(() => applyRelayMove(board, move, { sequence: 1, at: CLAIM_AT, kind: 'request', sender }), error => error.code === 'ENGINE_VERSION');
      assert.deepEqual(exportBoard(board), before);
      assert.equal(appliedSequence(board), 0);
    }
  }
});

test('a refused answerDecision is not attributed to an item sharing its shout id [H16]', t => {
  const { copies, item, source } = engineCopies(t);
  const [board] = copies;
  const shoutId = store.shout(source, {
    from: 'coordinator', to: 'person', text: 'Private refusal fixture', decision: true, lanes: ['web'],
  });
  assert.equal(shoutId, item, 'fixture needs a coincident shout and item id');
  const move = prepareEngineMove(board, 'answerDecision', [shoutId, {
    agentId: 'coordinator', text: 'Approved', lanes: ['web'],
  }], { id: 'forged-answer' });
  const refused = applyRelayMove(board, move, {
    sequence: 1, at: CLAIM_AT, kind: 'move', sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-1' },
  });
  assert.equal(refused.error.code, 'RELAY_SENDER_MISMATCH');
  assert.equal(store.events(board).at(-1).item_id, null, 'a shout id must not be mistaken for an item id');
});

test('fallback refusal identity hashes operation arguments when no ciphertext digest is supplied [H16]', t => {
  const { copies, item } = engineCopies(t);
  const board = copies[0];
  const move = claimMove(board, item, 'web-1');
  const envelope = { sequence: 1, at: CLAIM_AT, sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-1' }, kind: 'move', code: 'RELAY_MOVE' };
  const initial = refuseRelayMove(board, move, envelope);
  assert.match(initial.error.message, /this relay record was refused and logged; run pullboard relay to continue/);
  const changed = { ...move, args: [item, { ...move.args[1], head: 'b'.repeat(40) }] };
  assert.throws(() => refuseRelayMove(board, changed, envelope), { code: 'RELAY_CURSOR' }, 'changed contents cannot reuse an earlier refusal receipt');
});

test('released engine 3 stops a background completion before changing rows or its cursor [V2,H16]', async t => {
  const { copies, item } = engineCopies(t);
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-engine-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  unpackRelease('v0.8.1', directory);
  const released = await import(pathToFileURL(join(directory, 'src/engine.js')).href);
  const releasedMachine = await import(pathToFileURL(join(directory, 'src/machine.js')).href);
  assert.equal(releasedMachine.ENGINE_VERSION, 3, 'exercise the actual released client');
  assert.equal(released.ENGINE_OPERATIONS.includes('completeCheckBaseline'), false);
  assert.ok(ENGINE_OPERATIONS.includes('completeCheckBaseline'));
  const expected = { command: 'true', main: 'a'.repeat(40), request: '12345678-1234-1234-1234-123456789abc' };
  const baseline = { ...expected, result: 'green' };
  const sender = { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' };
  for (const board of copies) {
    store.editItem(board, item, { agentId: 'coordinator', check: expected.command, checkBaseline: { ...expected, result: 'pending' } });
    checkpointSequence(board, 7);
    const currentMove = prepareEngineMove(board, 'completeCheckBaseline', [item, { agentId: 'coordinator', expected, baseline }]);
    assert.equal(currentMove.engine, ENGINE_VERSION);
    assert.ok(ENGINE_VERSION >= 4, 'the current engine supports background completions');
    const move = { ...currentMove, engine: 4 }; // Keep the actual v4-versus-released-v3 compatibility boundary.
    const before = exportBoard(board);
    assert.throws(() => released.applyRelayMove(board, move, { sequence: 8, at: CLAIM_AT, kind: 'move', sender }), error => {
      assert.equal(error.code, 'ENGINE_VERSION');
      assert.match(error.message, /version 4.*version 3.*upgrade/i);
      return true;
    });
    assert.deepEqual(exportBoard(board), before, 'no refusal, receipt, item or replay metadata changes');
    assert.equal(released.appliedSequence(board), 7);
    const receipt = applyRelayMove(board, move, { sequence: 8, at: CLAIM_AT, kind: 'move', sender });
    assert.equal(Boolean(receipt.error), false);
    assert.equal(receipt.result, true);
    assert.equal(appliedSequence(board), 8);
    assert.equal(store.events(board).at(-1).event_kind, 'check-baseline');
  }
});

test('an engine 6 client meets an item hold and is told to upgrade [H16,M1]', async t => {
  const { copies, item } = engineCopies(t);
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-engine-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  unpackRelease('v0.8.3', directory);
  const released = await import(pathToFileURL(join(directory, 'src/engine.js')).href);
  const releasedMachine = await import(pathToFileURL(join(directory, 'src/machine.js')).href);
  assert.equal(releasedMachine.ENGINE_VERSION, 6, 'exercise the actual 0.8.3 client');
  assert.equal(released.ENGINE_OPERATIONS.includes('holdItem'), false);
  assert.equal(released.ENGINE_OPERATIONS.includes('releaseItemHold'), false);
  assert.ok(ENGINE_VERSION >= 7, 'the current engine supports item holds');
  assert.ok(ENGINE_OPERATIONS.includes('holdItem'));

  const board = copies[0];
  const oldMove = released.prepareEngineMove(board, 'claim', [item, {
    agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, head: 'a'.repeat(40),
    freeze: () => ({ text: '{"rows":[]}', digest: 'f'.repeat(64) }),
  }], { id: 'engine-6-understood-claim' });
  assert.equal(oldMove.engine, 6);
  const sender = { kind: 'agent', userId: 'fixture-user', agent: 'web-1' };
  const oldOutcome = released.applyRelayMove(board, oldMove, { sequence: 1, at: CLAIM_AT, kind: 'move', sender });
  assert.equal(Boolean(oldOutcome.error), false, 'the old client still applies an operation it understands');
  assert.equal(appliedSequence(board), 1);

  const hold = prepareEngineMove(board, 'holdItem', [item, {
    agentId: 'coordinator', reason: 'review the release',
  }], { id: 'engine-7-item-hold', actor: 'coordinator' });
  assert.equal(hold.engine, ENGINE_VERSION);
  const engine7Hold = { ...hold, engine: 7 };
  const before = exportBoard(board);
  let refusal;
  let refusalOutcome;
  try {
    refusalOutcome = released.applyRelayMove(board, engine7Hold, {
      sequence: 2, at: CLAIM_AT, kind: 'move', sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' },
    });
  } catch (error) {
    refusal = error;
  }
  const refusalCode = refusal?.code ?? refusalOutcome?.error?.code;
  const refusalMessage = refusal?.message ?? refusalOutcome?.error?.message ?? '';
  assert.equal(refusalCode, 'ENGINE_VERSION');
  assert.match(refusalMessage, /engine version 7.*engine version 6.*upgrade pullboard/i);
  assert.deepEqual(exportBoard(board), before, 'the old client refuses before changing item rows or replay receipts');
  assert.equal(appliedSequence(board), 1, 'the hold refusal does not advance the old client cursor');
});

test('a relay refusal receipt failure rolls back its log and cursor together [H2,H16]', t => {
  const { copies, item } = engineCopies(t);
  const board = copies[0];
  const before = exportBoard(board);
  board.db.exec("CREATE TEMP TRIGGER refuse_receipt BEFORE INSERT ON board_meta WHEN NEW.meta_key LIKE 'relay_refusal_%' BEGIN SELECT RAISE(ABORT, 'refusal receipt rollback'); END");
  assert.throws(() => applyRelayMove(board, claimMove(board, item, 'web-1'), { sequence: 1, at: CLAIM_AT, kind: 'move' }), /refusal receipt rollback/);
  assert.deepEqual(exportBoard(board), before);
  assert.equal(appliedSequence(board), 0);
});

test('the same sealed claim replays to identical rows and sequence retries are idempotent [H3,H16]', (t) => {
  const { copies, item } = engineCopies(t);
  const [one, two] = copies;
  const moveOne = claimMove(one, item, 'web-1');
  const moveTwo = claimMove(two, item, 'web-1');
  assert.deepEqual(moveOne, moveTwo, 'both clones serialize the same operation and actor');

  const first = applyEngineMove(one, moveOne, { sequence: 1, at: CLAIM_AT });
  const second = applyEngineMove(two, moveTwo, { sequence: 1, at: CLAIM_AT });
  assert.deepEqual(first, second);
  assert.equal(first.events.length, 1, 'the receipt names only this operation’s committed event');
  assert.equal(first.events[0].event_kind, 'claim');
  assert.equal(first.events[0].item_id, item);
  assert.deepEqual(boardRows(one, item), boardRows(two, item), 'event ids and claim/item timestamps match');
  assert.equal(store.getItem(one, item).item_owner, 'web-1');
  assert.equal(store.getItem(one, item).item_created_at, store.getItem(two, item).item_created_at);
  assert.equal(store.getItem(one, item).item_updated_at, CLAIM_AT);
  assert.equal(store.getItem(one, item).item_lease_until, '2026-10-07T20:00:00.000Z');
  assert.equal(replayCursor(one), 1);

  const eventCount = store.events(one).length;
  const repeated = applyEngineMove(one, moveOne, { sequence: 1, at: CLAIM_AT });
  assert.deepEqual(repeated, first, 'the identical committed sequence returns its recorded result');
  assert.equal(store.events(one).length, eventCount, 'a retry cannot append a duplicate event');
  assert.equal(replayCursor(one), 1);
  const laterOne = applyEngineMove(one, moveOne, { sequence: 2, at: '2026-10-07T18:01:00.000Z' });
  const laterTwo = applyEngineMove(two, moveTwo, { sequence: 2, at: '2026-10-07T18:01:00.000Z' });
  assert.deepEqual(laterOne, first, 'an identical operation at another relay position returns its first outcome');
  assert.deepEqual(laterTwo, first);
  assert.deepEqual(boardRows(one, item), boardRows(two, item));
  assert.equal(store.events(one).length, eventCount, 'a later identical id advances the prefix without another event');
  assert.equal(replayCursor(one), 2);
  assert.equal(replayCursor(two), 2);
  const beforeChangedId = exportBoard(one);
  const different = { ...moveOne, args: [item, { ...moveOne.args[1], agentId: 'web-2' }] };
  assert.throws(() => applyEngineMove(one, different, { sequence: 3, at: CLAIM_AT }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(one), beforeChangedId, 'the same id cannot name changed operation contents');
});

test('refusals are stable, newer engines name both versions, and gaps/unknown moves do not mutate [H3,H16]', (t) => {
  const { copies, item } = engineCopies(t);
  const [one, two] = copies;
  const first = claimMove(one, item, 'web-1');
  const replicaFirst = claimMove(two, item, 'web-1');
  applyEngineMove(one, first, { sequence: 1, at: CLAIM_AT });
  applyEngineMove(two, replicaFirst, { sequence: 1, at: CLAIM_AT });

  const refusedOne = applyEngineMove(one, claimMove(one, item, 'web-2'), { sequence: 2, at: CLAIM_AT });
  const refusedTwo = applyEngineMove(two, claimMove(two, item, 'web-2'), { sequence: 2, at: CLAIM_AT });
  assert.deepEqual(refusedOne.error, refusedTwo.error, 'the second actor sees the same refusal on both clones');
  assert.equal(refusedOne.error.code, 'HELD');
  assert.match(refusedOne.error.message, /web-1/);
  assert.match(refusedOne.error.message, /2026-10-07T20:00:00\.000Z/);
  assert.ok(refusedOne.error.next, 'the refusal includes its next step');
  assert.deepEqual(store.getItem(one, item), store.getItem(two, item));
  assert.equal(replayCursor(one), 2, 'a deterministic refusal is itself consumed in sequence');

  const beforeNewer = boardRows(one, item);
  const beforeNewerCursor = replayCursor(one);
  const newer = { ...claimMove(one, item, 'web-2'), engine: ENGINE_VERSION + 1 };
  assert.throws(() => applyEngineMove(one, newer, { sequence: 3, at: CLAIM_AT }), (error) => {
    assert.equal(error.code, 'ENGINE_VERSION');
    assert.match(error.message, new RegExp(`engine version ${ENGINE_VERSION + 1}.*engine version ${ENGINE_VERSION}`));
    assert.match(error.message, /upgrade pullboard/);
    return true;
  });
  assert.deepEqual(boardRows(one, item), beforeNewer);
  assert.equal(replayCursor(one), beforeNewerCursor, 'a future engine is refused before cursor advance');

  const unknown = { ...claimMove(one, item, 'web-2'), operation: 'drop-database' };
  assert.throws(() => applyEngineMove(one, unknown, { sequence: 3, at: CLAIM_AT }), { code: 'RELAY_MOVE' });
  assert.deepEqual(boardRows(one, item), beforeNewer);
  assert.equal(replayCursor(one), beforeNewerCursor);

  const gap = { ...claimMove(one, item, 'web-2'), id: 'gap-probe' };
  assert.throws(() => applyEngineMove(one, gap, { sequence: 4, at: CLAIM_AT }), { code: 'RELAY_ORDER' });
  assert.deepEqual(boardRows(one, item), beforeNewer);
  assert.equal(replayCursor(one), beforeNewerCursor);
});

test('an unexpected storage failure rolls back the partial transition and its cursor [H3,H16]', (t) => {
  const { copies, item } = engineCopies(t);
  const board = copies[0];
  const before = boardRows(board, item);
  board.db.exec(`CREATE TRIGGER engine_test_abort_event BEFORE INSERT ON event
    WHEN NEW.event_kind = 'claim' BEGIN SELECT RAISE(ABORT, 'engine rollback probe'); END`);

  assert.throws(() => applyEngineMove(board, claimMove(board, item, 'web-1'), { sequence: 1, at: CLAIM_AT }), /engine rollback probe/);
  assert.deepEqual(boardRows(board, item), before, 'the item update and attempted event append roll back together');
  assert.equal(replayCursor(board), 0, 'unexpected storage damage cannot be consumed as an engine refusal');
});

test('nested atomic moves roll back refused writes while their outer receipt can commit [H3,H16]', (t) => {
  const { copies, item } = engineCopies(t);
  const board = copies[0];
  const original = store.getItem(board, item).item_title;
  store.atomic(board, () => {
    assert.throws(() => store.atomic(board, () => {
      board.db.prepare('UPDATE item SET item_title=? WHERE item_id=?').run('partial failed write', item);
      throw new Refused('TEST_REFUSAL', 'restore the original value');
    }), { code: 'TEST_REFUSAL' });
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run('test_receipt', 'refused');
  });
  assert.equal(store.getItem(board, item).item_title, original);
  assert.equal(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('test_receipt').meta_value, 'refused');
});

const CHECKPOINT_AT = '2026-10-07T18:30:00.000Z';
const RECEIPT_ID = 'checkpoint-claim';

/** Open a source board with one applied move and an occupied, divergent same-board replica. */
function snapshotFixture(t) {
  const clock = { now: () => new Date(CHECKPOINT_AT) };
  const source = fixtureBoard(t, { clock });
  store.register(source, { lane: 'coordinator', path: '/source' });
  store.register(source, { lane: 'web', path: '/source/web-1' });
  const item = store.addItem(source, { by: 'coordinator', lane: 'web', title: 'Acknowledged item' });
  const base = exportBoard(source);
  const replica = fixtureBoard(t, { clock });
  importBoard(replica, base);
  store.addItem(replica, { by: 'coordinator', lane: 'web', title: 'Divergent local item' });

  const move = prepareEngineMove(source, 'claim', [item, {
    agentId: 'web-1',
    lane: 'web',
    leaseMs: 2 * HOUR,
    head: 'a'.repeat(40),
    freeze: () => ({ text: 'frozen checkpoint criterion', digest: 'b'.repeat(64) }),
  }], { id: RECEIPT_ID });
  const applied = applyMoveForSnapshot(source, move);
  assert.ok(applied.result, 'the checkpoint includes a successfully applied move');
  const document = exportBoard(source);
  return { source, replica, item, document };
}

/** Apply the fixture move at the fixed checkpoint sequence and event time. */
function applyMoveForSnapshot(board, move) {
  return applyEngineMove(board, move, { sequence: 1, at: CHECKPOINT_AT });
}

/** Clone a valid exchange document so a refusal test can damage one protocol field only. */
function cloneDocument(document) {
  return structuredClone(document);
}

/** Replace one board metadata value in a detached export document. */
function setDocumentMeta(document, key, value) {
  const row = document.tables.board_meta.find((entry) => entry.meta_key === key);
  if (row) row.meta_value = value;
  else document.tables.board_meta.push({ meta_key: key, meta_value: value });
}

/** Assert that a rejected snapshot preserves every row and SQLite sequence counter. */
function refusalLeavesRowsAlone(board, document, sequence, code) {
  const before = exportBoard(board);
  assert.throws(() => restoreRelaySnapshot(board, document, sequence), { code });
  assert.deepEqual(exportBoard(board), before, `${code} must not alter rows or AUTOINCREMENT counters`);
}

/** Remove only protocol metadata to compare user-visible board history across a relink. */
function withoutRelayMetadata(document) {
  return {
    ...document,
    tables: {
      ...document.tables,
      board_meta: document.tables.board_meta.filter((row) => !row.meta_key.startsWith('relay_')),
    },
  };
}

test('an acknowledged same-board checkpoint replaces divergent rows and retains its receipt [H3,H16]', (t) => {
  const { source, replica, item, document } = snapshotFixture(t);
  assert.notDeepEqual(exportBoard(replica), document, 'replica starts occupied and divergent');
  assert.equal(appliedSequence(source), 1);
  assert.ok(engineReceipt(source, RECEIPT_ID));

  restoreRelaySnapshot(replica, document, 1);

  assert.deepEqual(exportBoard(replica), document, 'the replica becomes the exact acknowledged prefix');
  assert.equal(store.boardId(replica), store.boardId(source));
  assert.equal(store.getItem(replica, item).item_status, 'claimed');
  assert.equal(appliedSequence(replica), 1);
  assert.deepEqual(engineReceipt(replica, RECEIPT_ID), engineReceipt(source, RECEIPT_ID));
});

test('wrong-board, mismatched/backward coverage and newer-engine checkpoints leave all rows untouched [H3,H16]', (t) => {
  const { replica, document } = snapshotFixture(t);

  const wrongBoard = cloneDocument(document);
  const boardId = document.tables.board_meta.find((row) => row.meta_key === 'board_id').meta_value;
  setDocumentMeta(wrongBoard, 'board_id', boardId === 'f'.repeat(32) ? 'e'.repeat(32) : 'f'.repeat(32));
  refusalLeavesRowsAlone(replica, wrongBoard, 1, 'RELAY_SNAPSHOT');

  refusalLeavesRowsAlone(replica, document, 2, 'RELAY_SNAPSHOT');

  replica.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run('relay_applied_sequence', '2');
  refusalLeavesRowsAlone(replica, document, 1, 'RELAY_SNAPSHOT');
  replica.db.prepare('UPDATE board_meta SET meta_value=? WHERE meta_key=?').run('0', 'relay_applied_sequence');

  const futureEngine = cloneDocument(document);
  setDocumentMeta(futureEngine, 'relay_engine_version', String(ENGINE_VERSION + 1));
  refusalLeavesRowsAlone(replica, futureEngine, 1, 'ENGINE_VERSION');
});

test('starting a relay epoch preserves board rows and events while clearing receipts and resetting sequence [H3,H16]', (t) => {
  const { source, document } = snapshotFixture(t);
  const before = exportBoard(source);
  assert.ok(engineReceipt(source, RECEIPT_ID));
  assert.equal(appliedSequence(source), 1);

  startRelayEpoch(source);

  const after = exportBoard(source);
  assert.deepEqual(withoutRelayMetadata(after), withoutRelayMetadata(before), 'items, agents, shouts, verdicts and event history remain intact');
  assert.equal(store.boardId(source), document.tables.board_meta.find((row) => row.meta_key === 'board_id').meta_value);
  assert.equal(appliedSequence(source), 0);
  assert.equal(engineReceipt(source, RECEIPT_ID), null);
  assert.equal(source.db.prepare("SELECT COUNT(*) AS count FROM board_meta WHERE meta_key LIKE 'relay_receipt_%'").get().count, 0);
  assert.equal(Number(after.tables.board_meta.find((row) => row.meta_key === 'relay_engine_version').meta_value), ENGINE_VERSION);
});


test('a failed durable receipt rolls back an otherwise successful move and its cursor [H3,H16]', (t) => {
  const { copies, item } = engineCopies(t);
  const board = copies[0];
  const before = exportBoard(board);
  board.db.exec(`CREATE TRIGGER engine_test_abort_receipt BEFORE INSERT ON board_meta
    WHEN NEW.meta_key LIKE 'relay_receipt_%' BEGIN SELECT RAISE(ABORT, 'receipt rollback probe'); END`);
  assert.throws(() => applyEngineMove(board, claimMove(board, item, 'web-1'), { sequence: 1, at: CLAIM_AT }), /receipt rollback probe/);
  assert.deepEqual(exportBoard(board), before, 'receipt failure cannot leave a committed claim without its replay position');
  assert.equal(replayCursor(board), 0);
});

test('engine 65 keeps an ordinary claim available without a return window [B13,H16]', t => {
  const { copies: [board], item } = engineCopies(t, undefined, 65);
  const move = { ...claimMove(board, item, 'web-2'), engine: 65 };
  const result = applyEngineMove(board, move, { sequence: 1, at: CLAIM_AT });
  assert.equal(result.error, undefined);
  assert.equal(store.getItem(board, item).item_owner, 'web-2');
});

test('return-window engine admission uses the receipt time rather than replica clocks [B13,H16]', t => {
  const { copies: [insideClock, expiredClock], item } = engineCopies(t, board => {
    board.clock = { now: () => new Date('2026-10-07T16:00:00.000Z') };
    const id = store.listItems(board)[0].item_id;
    store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR,
      freeze: () => ({ text: '{"criterion":"Engine fixture","rows":[]}', digest: 'f'.repeat(64) }) });
    submitFixture(board, id, { agentId: 'web-1', commit: 'a'.repeat(40), tree: 'a'.repeat(40) });
    store.verify(board, id, { agentId: 'web-2', decision: 'REJECT', reason: 'OTHER', note: 'proof', clause: 'Engine fixture',
      head: 'a'.repeat(40), digest: 'f'.repeat(64), policy: 'any', reopenFirstRefusalMinutes: 30 });
  }, 66);
  const before = boardRows(expiredClock, item);
  const old = { ...claimMove(expiredClock, item, 'web-2'), engine: 65 };
  assert.throws(() => applyEngineMove(expiredClock, old, { sequence: 1, at: '2026-10-07T16:05:00.000Z' }), /engine/);
  assert.deepEqual(boardRows(expiredClock, item), before);
  assert.equal(appliedSequence(expiredClock), 0);
  const atExpiry = { ...claimMove(insideClock, item, 'web-2'), engine: 65 };
  const result = applyEngineMove(insideClock, atExpiry, { sequence: 1, at: '2026-10-07T16:30:00.000Z' });
  assert.equal(result.error, undefined);
  assert.equal(store.getItem(insideClock, item).item_owner, 'web-2');
});

test('the engine version is the highest feature engine [C7,V4]', () => {
  const entries = Object.entries(ENGINE_REGISTRY);
  assert.ok(entries.length > 0, 'the registry names at least one feature engine');
  for (const [name, engine] of entries) assert.ok(Number.isSafeInteger(engine) && engine > 0, `feature ${name} declares a positive whole engine number`);
  assert.equal(ENGINE_VERSION, Math.max(...entries.map(([, engine]) => engine)), 'the engine version is the highest number any feature declares');
  const source = new URL('../../state/src/logic/engines/', import.meta.url);
  const files = readdirSync(source).filter((file) => /-engine\.js$/u.test(file));
  assert.deepEqual(Object.keys(ENGINE_REGISTRY), files.map((file) => file.slice(0, -'-engine.js'.length)).sort(), 'every engines-folder *-engine.js leaf is a feature engine, discovered by its file name');
  const declarations = files.map(file => {
    const text=readFileSync(new URL(file, source),'utf8');
    const lines=text.split('\n').filter(line=>/^export const /u.test(line));
    assert.equal(lines.length,1,`${file} has exactly one exported engine declaration`);
    const match=/^export const [A-Z][A-Z0-9_]*_ENGINE = (?:(\d+)|unassignedEngine\(\));$/u.exec(lines[0]);
    assert.ok(match,`${file} declares its landed number or the accepted unassigned placeholder`);
    if (match[1]===undefined) assert.ok(text.split('\n').includes("import { unassignedEngine } from '../../../test/engine-next.js';"),`${file} imports its real placeholder`);
    return {file,number:match[1]===undefined ? null : Number(match[1])};
  });
  const next=Math.max(0,...declarations.map(row=>row.number??0))+1;
  for (const row of declarations) assert.equal(ENGINE_REGISTRY[row.file.slice(0,-'-engine.js'.length)],row.number??next,'unlanded branches read one above the highest assigned engine');
  assert.doesNotMatch(readFileSync(new URL('../../state/src/io/machine.js', import.meta.url), 'utf8'), /Math\.max\([A-Z_]+ENGINE,/u, 'packages/state/src/io/machine.js lists no engine by name');
});

test('a feature engine or command file name outside letters, digits, underscore and hyphen is refused by discovery [C7,V4]', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-discovery-'));
  try {
    writeFileSync(join(directory, 'check-alpha-engine.js'), 'export const CHECK_ALPHA_ENGINE = 70;\n');
    assert.deepEqual(discoverEngines(pathToFileURL(directory + '/')), { 'check-alpha': 70 }, 'a hyphenated engine file is discovered');
    writeFileSync(join(directory, 'check.beta-engine.js'), 'export const CHECK_BETA_ENGINE = 71;\n');
    assert.throws(() => discoverEngines(pathToFileURL(directory + '/')), /check\.beta-engine\.js cannot be a feature engine/u, 'a dotted engine file is refused by name');
  } finally { rmSync(directory, { recursive: true, force: true }); }
  assert.deepEqual(discovered(['index.js', 'add.js', 'two-words.js'], COMMAND_CANDIDATE, COMMAND_FILE, 'command'), ['add.js', 'two-words.js']);
  assert.throws(() => discovered(['index.js', 'add.js', 'a.b.js'], COMMAND_CANDIDATE, COMMAND_FILE, 'command'), /a\.b\.js cannot be a command/u, 'a dotted command file is refused by name');
});


test('engine 93 item messages replay and older broadcasts keep their recorded meaning [B7,H3,H16]', (t) => {
  const { copies, item } = engineCopies(t);
  const [one, two] = copies;
  const legacy = { ...prepareEngineMove(one, 'shout', [{ from: 'web-1', to: 'all', text: 'old broadcast', lanes: ['web'] }]), engine: 92 };
  for (const board of copies) applyEngineMove(board, legacy, { sequence: 1, at: CLAIM_AT });
  assert.equal(store.inbox(one, 'web-2')[0].shout_text, 'old broadcast');
  const message = prepareEngineMove(one, 'shout', [{ from: 'web-1', to: 'web', item, text: 'item message', lanes: ['web'] }]);
  assert.throws(() => applyEngineMove(two, { ...message, engine: 92 }, { sequence: 2, at: CLAIM_AT }), /RELAY_MOVE/);
  const first = applyEngineMove(one, message, { sequence: 2, at: CLAIM_AT });
  const second = applyEngineMove(two, message, { sequence: 2, at: CLAIM_AT });
  assert.deepEqual(first, second);
  assert.equal(store.getShout(one, first.result).shout_to, `item:${item}`);
  assert.equal(store.getShout(two, second.result).shout_to, `item:${item}`);
  const report = prepareEngineMove(one, 'shout', [{ from: 'web-1', to: 'all', text: 'new private report', lanes: ['web'] }]);
  const reports = copies.map(board => applyEngineMove(board, report, { sequence: 3, at: CLAIM_AT }));
  assert.deepEqual(reports[0], reports[1]);
  for (const [index, board] of copies.entries()) {
    assert.equal(store.getShout(board, reports[index].result).shout_to, 'coordinator+person');
    assert.equal(store.inbox(board, 'web-2').some(shout => shout.shout_text === 'new private report'), false);
    assert.equal(store.inbox(board, 'coordinator').some(shout => shout.shout_text === 'new private report'), true);
    assert.equal(store.recentShouts(board).find(shout => shout.shout_text === 'old broadcast').shout_to, 'all',
      'recorded old broadcast remains global, rather than being reinterpreted by its sender');
  }
});

test('outside author facts and exact owner approval replay without manufacturing a native builder [H3,H16,B26]', async t => {
  const { createHash } = await import('node:crypto');
  const outsideIntake = await import('../../state/light.js');
  const { copies: [one, two] } = engineCopies(t);
  // These object IDs exercise deterministic storage only; no outside program or sandbox execution is claimed.
  const text = JSON.stringify({ title: 'Outside replay fixture', criterion: 'record the source', rows: [], check: 'true' });
  const frozen = { text, digest: createHash('sha256').update(text).digest('hex') };
  const source = { kind: 'pull-request', repository: 'fixture/project', number: 7, author: 'outside-contributor', state: 'open', maintainerReplied: true,
    commit: 'a'.repeat(40), tree: 'b'.repeat(40), base: 'c'.repeat(40), files: ['apps/relay/src/io/deploy/outside.js'], sensitive: true };
  const move = prepareEngineMove(one, 'intakeOutside', [{ agentId: 'coordinator', source, frozen,
    item: { lane: 'web', title: 'Outside replay fixture', criterion: 'record the source', check: 'true' } }], { id: 'outside-replay-intake' });
  for (const board of [one, two]) {
    const before = exportBoard(board);
    assert.throws(() => applyEngineMove(board, { ...move, engine: outsideIntake.OUTSIDE_INTAKE_ENGINE - 1 }, { sequence: 1, at: CLAIM_AT }), /RELAY_MOVE/);
    assert.deepEqual(exportBoard(board), before, 'an older engine cannot partially introduce outside semantics');
  }
  const ids = [one, two].map(board => applyEngineMove(board, move, { sequence: 1, at: CLAIM_AT }).result);
  assert.equal(ids[0], ids[1]);
  const id = ids[0];
  const item = store.getItem(one, id);
  assert.equal(item.item_status, 'submitted');
  assert.equal(item.item_built_by, 'outside:github:outside-contributor');
  assert.equal(store.listAgents(one).some(agent => agent.agent_id === item.item_built_by), false);
  const approval = prepareEngineMove(one, 'approveOutside', [id, { agentId: 'person' }], { id: 'outside-replay-approval' });
  for (const board of [one, two]) {
    const before = exportBoard(board);
    assert.throws(() => store.approveOutside(board, id, { agentId: 'web-1' }), /B26_PERSON_CHANNEL/);
    assert.deepEqual(exportBoard(board), before, 'an agent cannot acquire person approval by naming its own native seat');
    applyRelayMove(board, approval, { sequence: 2, at: CLAIM_AT, kind: 'move', sender: { kind: 'person', userId: 'fixture-owner', policy: ENGINE_VERSION } });
    assert.deepEqual(store.getItem(board, id).outside.ownerApproval, { by: 'person', commit: source.commit, at: CLAIM_AT });
  }
  assert.deepEqual(exportBoard(one).tables, exportBoard(two).tables);
  const imported = fixtureBoard(t);
  importBoard(imported, exportBoard(one));
  assert.deepEqual(store.getItem(imported, id).outside, store.getItem(one, id).outside, 'public facts and approval survive the native export boundary');
});


test('state runtime ports preserve native events and duplicate receipts [C7,H16]', (t) => {
  const control = fixtureBoard(t);
  const supplied = fixtureBoard(t);
  const calls = [];
  const nativePorts = supplied.enginePorts;
  const board = { ...supplied, enginePorts: Object.freeze({ ...nativePorts,
    /** Observe the explicit provider call while retaining its real authorization judgment. */
    requireCoordinatorHold(...args) {
      calls.push('coordinator-hold');
      return nativePorts.requireCoordinatorHold(...args);
    },
  }) };
  const move = prepareEngineMove(board, 'ensureCoordinator', ['/explicit-state-port'], { id: 'explicit-runtime-port' });
  assert.deepEqual(Object.keys(move).sort(), ['args', 'engine', 'id', 'operation', 'version']);
  const record = { sequence: 1, at: CLAIM_AT };
  const expected = applyEngineMove(control, move, record);
  const actual = applyEngineMove(board, move, record);
  assert.equal(actual.error, undefined);
  assert.deepEqual(actual, expected, 'ports preserve the original native outcome and recorded events');
  assert.deepEqual(calls, ['coordinator-hold']);
  assert.deepEqual(applyEngineMove(board, move, record), actual, 'duplicate receipt is returned without execution');
  assert.deepEqual(calls, ['coordinator-hold'], 'receipt replay never repeats the provider operation');
  assert.deepEqual(engineReceipt(board, move.id), engineReceipt(control, move.id));
});

test('state refuses a missing runtime port before invoking origin callbacks [C7,H16]', (t) => {
  const board = fixtureBoard(t);
  const unbound = { ...board, enginePorts: undefined };
  let called = false;
  assert.throws(() => prepareEngineMove(unbound, 'claim', [1, {
    /** An unbound store must refuse before any caller-supplied freezing effect. */
    freeze() { called = true; },
  }]), { code: 'RELAY_MOVE' });
  assert.equal(called, false);
  assert.equal(appliedSequence(board), 0);
  assert.deepEqual(store.events(board), []);
});
