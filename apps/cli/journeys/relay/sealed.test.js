/** Two real clients and encrypted CLI records exercise the relay without sharing their key [A4,H7]. */
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { fixture } from '../../tests/fixtures/relay/sealed.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  runFixtureExecFile as execFileSync,
  runFixtureChild as spawnSync,
  cleanupFixtureChildren,
} from '../../tests/fixtures/child.js';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { main } from '../../tests/fixtures/native.js';
import { exportBoard } from '../../../../packages/store/index.js';
import {
  checkpointSequence,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import { seal as sealMove } from '../../../../packages/kernel/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import {
  replayClient,
  initializeReplica,
  replayClientWithoutCheckpoint,
  independentReplayOrigin,
  replayResult,
} from '../../tests/fixtures/relay/sealed-client.js';

after(cleanupFixtureChildren);

test('sealed agent shout cannot answer a person decision on either independent client [H16,B26]', async t => {
  const box = await fixture(t);
  const source = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  let document, question, forged, ordinary, answer;
  try {
    const lane = store.getItem(source, 1).item_lane;
    assert.equal(store.register(source, { lane: 'remote', path: join(box.directory, 'remote') }), 'remote-1');
    question = store.shout(source, {
      from: 'coordinator', to: 'person', text: 'Approve this change?', decision: true, lanes: [lane],
    });
    checkpointSequence(source, 0);
    // This is intentionally a raw authenticated-agent shout, not answerDecision.
    // The relay must reject its answer relation before insertShout can close the question.
    forged = prepareEngineMove(source, 'shout', [{
      from: 'remote-1', to: 'coordinator', text: 'Forged approval', answers: question, lanes: [lane],
    }]);
    ordinary = prepareEngineMove(source, 'shout', [{
      from: 'remote-1', to: 'all', text: 'Ordinary agent observation', lanes: [lane],
    }]);
    answer = prepareEngineMove(source, 'answerDecision', [question, {
      agentId: 'coordinator', asPerson: true, text: 'Approved by the person', lanes: [lane],
    }]);
    document = JSON.parse(JSON.stringify(exportBoard(source)));
  } finally { store.closeBoard(source); }

  const remote = await box.auth.issueToken(box.machines[0].token, { board: box.id, agent: 'remote-1' });
  const roots = [box.root, join(box.directory, 'second-client')];
  const homes = [box.home, join(box.directory, 'second-home')];
  const envs = homes.map(home => ({ ...box.env, HOME: home, PULLBOARD_HOME: home }));
  mkdirSync(roots[1]); mkdirSync(homes[1], { mode: 0o700 });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: roots[1], env: envs[1] }).status, 0);
  await initializeReplica(roots[1], envs[1]);
  const native = join(box.directory, 'native.json');
  writeFileSync(native, JSON.stringify(document), { mode: 0o600 });
  await replayClient(roots[1], envs[1], 'import', native);
  for (let i = 0; i < roots.length; i++) {
    const keyDirectory = join(homes[i], 'relay-keys');
    mkdirSync(keyDirectory, { mode: 0o700 });
    writeFileSync(join(keyDirectory, box.id + '.key'), box.key.toString('base64url') + '\n', { mode: 0o600 });
    const url = await independentReplayOrigin(t, box.origin);
    writeFileSync(join(roots[i], '.git/pullboard/relay.json'), JSON.stringify({
      version: 1, mode: 'ordered', board: box.id, url, repository: 'fixture/repository',
      token: box.machines[i].token, sequence: 0, cursor: document.tables.event.at(-1).event_id,
    }) + '\n', { mode: 0o600 });
  }

  /** Send a production-sealed move using its actual authenticated relay credential. */
  async function upload(move, sequence, token = remote.token) {
    const sealed = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(move)), {
      boardId: box.id, kind: 'move', sequence,
    })).toString('base64url');
    const reply = await box.call(box.path + '/moves', {
      method: 'POST', token, body: { sequence, sealed },
    });
    assert.equal(reply.status, 200);
    return reply;
  }
  const snapshot = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(document)), {
    boardId: box.id, kind: 'snapshot', sequence: 0,
  })).toString('base64url');
  assert.equal((await box.call(box.path + '/state', {
    method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: snapshot },
  })).status, 200);
  const forgedUpload = await upload(forged, 1);
  assert.equal(forgedUpload.body.event.sender.agent, 'remote-1');
  await upload(ordinary, 2);

  const refusedReplicas = [];
  for (let i = 0; i < roots.length; i++) {
    const result = await replayResult(roots[i], envs[i], 'export');
    assert.equal(result.status, 0);
    const doc = result.document;
    const q = doc.tables.shout.find(row => row.shout_id === question);
    assert.ok(q && q.shout_decision, 'the person decision remains present');
    assert.equal(doc.tables.shout.some(row => row.shout_answers === question), false, 'the refused agent record did not answer it');
    assert.equal(doc.tables.shout.at(-1).shout_text, 'Ordinary agent observation', 'ordinary agent shouts remain allowed');
    const refusal = doc.tables.event.find(row => row.event_kind === 'relay_refused' && row.event_by === 'remote-1');
    assert.equal(JSON.parse(refusal.event_detail).code, 'RELAY_ANSWER');
    assert.equal(doc.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value, '2');
    const board = openBoard(join(roots[i], '.git/pullboard/board.sqlite'));
    try { assert.deepEqual(store.openDecisions(board, 'person').map(row => row.shout_id), [question]); }
    finally { store.closeBoard(board); }
    refusedReplicas.push(doc.tables);
  }
  assert.deepEqual(refusedReplicas[0], refusedReplicas[1], 'both clients independently replay the refusal and allowed shout');
  const beforeAnswer = refusedReplicas[0];

  // A valid, sealed person decision preserves the existing guarded answer path.
  await upload(answer, 3, box.person.token);
  const answered = [];
  for (let i = 0; i < roots.length; i++) {
    const result = await replayResult(roots[i], envs[i], 'export');
    assert.equal(result.status, 0);
    const doc = result.document;
    assert.equal(doc.tables.shout.some(row => row.shout_answers === question && row.shout_text === 'Approved by the person'), true);
    assert.equal(doc.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value, '3');
    assert.deepEqual(doc.tables.event.slice(0, beforeAnswer.event.length), beforeAnswer.event, 'the guarded answer preserves every earlier event row');
    assert.deepEqual(doc.tables.shout.slice(0, beforeAnswer.shout.length), beforeAnswer.shout, 'the guarded answer preserves earlier shout IDs and raw rows');
    const board = openBoard(join(roots[i], '.git/pullboard/board.sqlite'));
    try { assert.deepEqual(store.openDecisions(board, 'person'), []); }
    finally { store.closeBoard(board); }
    answered.push(doc.tables);
  }
  assert.deepEqual(answered[0], answered[1], 'both clients apply the actual guarded person answer identically');
  const retained = await box.call(box.path + '/state');
  assert.equal(retained.body.state.sequence, 0);
  assert.equal(retained.body.state.sealed, snapshot, 'both clients independently replayed rather than importing a published checkpoint');
});

test('two real clients stop before sender checks for newer operations and actor layouts without advancing [H16]', async t => {
  const futureEngine = ENGINE_VERSION + 1;
  const versionMessage = new RegExp(`engine version ${futureEngine}.*engine version ${ENGINE_VERSION}`);
  const unknown = { version: 1, engine: futureEngine, id: 'future-operation', operation: 'futureOp', args: [{ agentId: 'remote-1' }] };
  const shifted = { version: 1, engine: futureEngine, id: 'future-claim', operation: 'claim', args: [1, {}, { agentId: 'remote-1' }] };
  for (const [name, moves] of [['new operation', [unknown]], ['new actor layout', [shifted]], ['current engine sender checks', [unknown, shifted].map(move => ({ ...move, engine: ENGINE_VERSION }))]]) {
    await t.test(name, async sub => {
      const box = await fixture(sub);
      const source = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
      let document;
      try {
        checkpointSequence(source, 0);
        document = JSON.parse(JSON.stringify(exportBoard(source)));
      } finally { store.closeBoard(source); }
      const remote = await box.auth.issueToken(box.machines[0].token, { board: box.id, agent: 'remote-1' });
      const roots = [box.root, join(box.directory, 'second-client')];
      const homes = [box.home, join(box.directory, 'second-home')];
      const envs = homes.map(home => ({ ...box.env, HOME: home, PULLBOARD_HOME: home }));
      mkdirSync(roots[1]); mkdirSync(homes[1], { mode: 0o700 });
      assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: roots[1], env: envs[1] }).status, 0);
      await initializeReplica(roots[1], envs[1]);
      const native = join(box.directory, 'native.json');
      writeFileSync(native, JSON.stringify(document), { mode: 0o600 });
      await replayClient(roots[1], envs[1], 'import', native);
      const links = roots.map(root => join(root, '.git/pullboard/relay.json'));
      for (let index = 0; index < roots.length; index += 1) {
        const keyDirectory = join(homes[index], 'relay-keys');
        mkdirSync(keyDirectory, { mode: 0o700 });
        writeFileSync(join(keyDirectory, box.id + '.key'), box.key.toString('base64url') + '\n', { mode: 0o600 });
        const replayOrigin = await independentReplayOrigin(sub, box.origin);
        writeFileSync(links[index], JSON.stringify({ version: 1, mode: 'ordered', board: box.id, url: replayOrigin, repository: 'fixture/repository', token: box.machines[index].token, sequence: 0, cursor: document.tables.event.at(-1).event_id }) + '\n', { mode: 0o600 });
      }
      const originalLinks = links.map(file => readFileSync(file, 'utf8'));
      const initialSnapshot = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(document)), { boardId: box.id, kind: 'snapshot', sequence: 0 })).toString('base64url');
      assert.equal((await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: initialSnapshot } })).status, 200);
      for (let index = 0; index < moves.length; index += 1) {
        const sequence = index + 1;
        const sealed = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(moves[index])), { boardId: box.id, kind: 'move', sequence })).toString('base64url');
        const uploaded = await box.call(box.path + '/moves', { method: 'POST', token: remote.token, body: { sequence, sealed } });
        assert.equal(uploaded.status, 200);
        assert.equal(uploaded.body.event.sender.agent, 'remote-1');
      }
      const results = [];
      for (let index = 0; index < roots.length; index += 1) {
        const result = await replayResult(roots[index], envs[index], 'export');
        assert.equal(result.status, 0);
        results.push(result.document);
        if (moves[0].engine === futureEngine) {
          assert.match((result.document.diagnostics ?? []).join('\n'), new RegExp(`\\[ENGINE_VERSION\\].*${versionMessage.source}.*upgrade pullboard`), 'future records stop before interpreting the sending agent');
          assert.deepEqual(result.document.tables, document.tables, 'no board row, receipt or persisted cursor changes');
          assert.equal(readFileSync(links[index], 'utf8'), originalLinks[index], 'the saved transport cursor is unchanged');
          const retried = await replayResult(roots[index], envs[index], 'export');
          assert.match((retried.document.diagnostics ?? []).join('\n'), /\[ENGINE_VERSION\]/);
          assert.equal(retried.status, 0);
          assert.deepEqual(retried.document.tables, document.tables, 'retry still stops at the same unapplied record');
          const attempted = await replayResult(roots[index], envs[index], 'add', document.tables.item[0].item_lane, 'Later local move must wait');
          assert.equal(attempted.status, 1);
          assert.equal(attempted.document.error.code, 'ENGINE_VERSION');
          assert.match(attempted.document.error.message, versionMessage);
          assert.equal(readFileSync(links[index], 'utf8'), originalLinks[index]);
          const board = openBoard(join(roots[index], '.git/pullboard/board.sqlite'));
          try { assert.deepEqual(JSON.parse(JSON.stringify(exportBoard(board))).tables, document.tables, 'a later local mutation cannot pass the future record'); }
          finally { store.closeBoard(board); }
        } else {
          assert.doesNotMatch((result.document.diagnostics ?? []).join('\n'), /\[ENGINE_VERSION\]/);
          assert.deepEqual(result.document.tables.item, document.tables.item);
          assert.deepEqual(result.document.tables.shout, document.tables.shout);
          assert.deepEqual(result.document.tables.verdict, document.tables.verdict);
          const refused = result.document.tables.event.filter(row => row.event_kind === 'relay_refused');
          assert.deepEqual(refused.map(row => JSON.parse(row.event_detail).code), ['RELAY_SENDER_MISMATCH', 'RELAY_SENDER_MISMATCH']);
          assert.ok(refused.every(row => row.event_by === 'remote-1'));
          assert.equal(result.document.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value, '2');
          assert.equal(JSON.parse(readFileSync(links[index], 'utf8')).sequence, 2);
        }
      }
      assert.deepEqual(results[0].tables, results[1].tables, 'the two independent clients retain identical board rows');
      const snapshot = await box.call(box.path + '/state');
      assert.equal(snapshot.body.state.sequence, 0);
      assert.equal(snapshot.body.state.sealed, initialSnapshot, 'neither client replaced independent replay with a shared checkpoint');
    });
  }
});

test('two real clients refuse forged relay actors and person-only requests while advancing identically [H2,H16]', async t => {
  const box = await fixture(t);
  const source = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  let document, question, moves;
  try {
    const lane = store.getItem(source, 1).item_lane;
    assert.equal(store.register(source, { lane: 'remote', path: join(box.directory, 'remote') }), 'remote-1');
    store.claim(source, 1, { agentId: 'remote-1', lane, leaseMs: 3600000, freeze: () => ({ text: '{}', digest: 'd'.repeat(64) }) });
    submitFixture(source, 1, { agentId: 'remote-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
    question = store.shout(source, { from: 'coordinator', to: 'person', text: 'Private person decision', decision: true, lanes: [lane] });
    checkpointSequence(source, 0);
    moves = [
      prepareEngineMove(source, 'verify', [1, { agentId: 'coordinator', decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'forged acceptance', head: 'a'.repeat(40), digest: 'd'.repeat(64), policy: 'any' }]),
      prepareEngineMove(source, 'answerDecision', [question, { agentId: 'coordinator', asPerson: true, text: 'forged person answer', lanes: [lane] }]),
      { version: 1, type: 'person-request', id: 'forged-person-request', move: { verb: 'shout', args: { to: 'coordinator', text: 'forged person request' } } },
      prepareEngineMove(source, 'recordRowDecisions', [{ agentId: 'remote-1', channel: 'view', decisions: [] }]),
      prepareEngineMove(source, 'appendFact', [1, { agentId: 'coordinator', kind: 'note', text: 'forged fact' }]),
      prepareEngineMove(source, 'shout', [{ from: 'remote-1', to: 'all', text: 'valid remote observation', lanes: [lane] }]),
    ];
    document = JSON.parse(JSON.stringify(exportBoard(source)));
  } finally { store.closeBoard(source); }
  const remote = await box.auth.issueToken(box.machines[0].token, { board: box.id, agent: 'remote-1' });
  const roots = [box.root, join(box.directory, 'second-client')];
  const homes = [box.home, join(box.directory, 'second-home')];
  const envs = homes.map(home => ({ ...box.env, HOME: home, PULLBOARD_HOME: home }));
  mkdirSync(roots[1]); mkdirSync(homes[1], { mode: 0o700 });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: roots[1], env: envs[1] }).status, 0);
  await initializeReplica(roots[1], envs[1]);
  const snapshotFile = join(box.directory, 'native.json');
  writeFileSync(snapshotFile, JSON.stringify(document), { mode: 0o600 });
  await replayClient(roots[1], envs[1], 'import', snapshotFile);
  for (let index = 0; index < roots.length; index += 1) {
    const keyDirectory = join(homes[index], 'relay-keys');
    mkdirSync(keyDirectory, { mode: 0o700 });
    writeFileSync(join(keyDirectory, box.id + '.key'), box.key.toString('base64url') + '\n', { mode: 0o600 });
    writeFileSync(join(roots[index], '.git/pullboard/relay.json'), JSON.stringify({ version: 1, mode: 'ordered', board: box.id, url: box.origin, repository: 'fixture/repository', token: box.machines[index].token, sequence: 0, cursor: document.tables.event.at(-1).event_id }) + '\n', { mode: 0o600 });
  }
  /** Seal production-format records on this client; the relay stores only their opaque envelopes. */
  async function upload(value, kind, sequence, token = remote.token) {
    const sealed = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(value)), { boardId: box.id, kind, sequence })).toString('base64url');
    const reply = await box.call(box.path + (kind === 'snapshot' ? '/state' : kind === 'request' ? '/requests' : '/moves'), { method: kind === 'snapshot' ? 'PUT' : 'POST', token, body: { sequence, sealed } });
    assert.equal(reply.status, 200, 'the real relay accepts the opaque authorized upload');
  }
  await upload(document, 'snapshot', 0, box.person.token);
  for (let index = 0; index < moves.length; index += 1) await upload(moves[index], index === 2 ? 'request' : 'move', index + 1);
  const exported = await Promise.all(roots.map((root, index) => replayClient(root, envs[index], 'export')));
  assert.deepEqual(exported[0].tables, exported[1].tables, 'every replica keeps exactly the same rows and refusal receipts');
  const result = exported[0];
  assert.deepEqual(result.tables.item, document.tables.item, 'forged verification changes no item');
  assert.deepEqual(result.tables.verdict, document.tables.verdict, 'forged acceptance leaves the verdict unchanged');
  const newShouts = result.tables.shout.filter(row => row.shout_id > document.tables.shout.at(-1).shout_id);
  assert.equal(newShouts.length, 1, 'only the permitted observation creates a shout');
  assert.equal(newShouts[0].shout_from, 'remote-1');
  assert.equal(newShouts[0].shout_text, 'valid remote observation');
  const refused = result.tables.event.filter(row => row.event_kind === 'relay_refused');
  assert.equal(refused.length, 5);
  assert.ok(refused.every(row => row.event_by === 'remote-1'), 'the log attributes every attempted forgery to its authenticated sender');
  assert.deepEqual(refused.map(row => JSON.parse(row.event_detail).code), ['RELAY_SENDER_MISMATCH', 'RELAY_PERSON_ONLY', 'RELAY_PERSON_ONLY', 'RELAY_PERSON_ONLY', 'RELAY_SENDER_MISMATCH']);
  assert.equal(JSON.parse(refused[0].event_detail).actor, 'coordinator');
  assert.equal(result.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value, '6');
  assert.equal(refused[4].item_id, 1, 'a refused appendFact names its existing item');
  for (let index = 0; index < roots.length; index += 1) {
    const itemLog = await replayClient(roots[index], envs[index], 'log', '1');
    assert.ok(itemLog.events.some(row => row.event_kind === 'relay_refused' && JSON.parse(row.event_detail).operation === 'appendFact'),
      'each real CLI item log includes the refused fact');
  }
  const log = await replayClient(roots[1], envs[1], 'log');
  assert.deepEqual(log.events.filter(row => row.event_kind === 'relay_refused'), refused, 'pullboard log exposes the sending agent and attempted actor');
  assert.deepEqual((await replayClient(roots[0], envs[0], 'export')).tables, result.tables, 'repeat catch-up does not duplicate refusals or actions');
});

test('two real clients enforce the verify policy captured in the item freeze [H16,O2]', { timeout: 240_000 }, async t => {
  // The injected faults address the released whole-ciphertext API1 checkpoint contract.
  const box = await fixture(t, { legacySnapshots: true });
  const configPath = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.verify = { ...config.verify, policy: 'coordinator', family: 'require' };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  execFileSync('git', ['add', 'pullboard.json', 'SPEC.md'], { cwd: box.root, env: {
    ...box.env, GIT_AUTHOR_NAME: 'Policy Fixture', GIT_AUTHOR_EMAIL: 'policy@example.invalid',
    GIT_COMMITTER_NAME: 'Policy Fixture', GIT_COMMITTER_EMAIL: 'policy@example.invalid',
  } });
  execFileSync('git', ['commit', '-q', '-m', 'test(relay): pin verify fixture policy'], { cwd: box.root, env: {
    ...box.env, GIT_AUTHOR_NAME: 'Policy Fixture', GIT_AUTHOR_EMAIL: 'policy@example.invalid',
    GIT_COMMITTER_NAME: 'Policy Fixture', GIT_COMMITTER_EMAIL: 'policy@example.invalid',
  } });
  const lane = Object.keys(config.lanes)[0];
  const builder = join(box.directory, 'builder');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'builder-policy', builder, 'HEAD'], { cwd: box.root, env: box.env });
  /** Run native setup commands from the real linked builder worktree. */
  const runBuilder = (...args) => {
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../pullboard.js'), ...args, '--json'], { cwd: builder, env: box.env, encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout || 'the real native CLI prepares a fresh claim under the pinned main policy');
    return JSON.parse(result.stdout);
  };
  const joined = runBuilder('join', lane, '--route', 'strong', '--family', 'Builder Family');
  const builderId = joined.agent;
  assert.equal(typeof builderId, 'string');
  runBuilder('claim', '1');

  const source = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: box.root, env: box.env, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: box.root, env: box.env, encoding: 'utf8' }).trim();
  let verifierSame;
  let verifierOther;
  let legacyDigest;
  try {
    const item = store.getItem(source, 1);
    const frozen = JSON.parse(item.item_frozen);
    assert.equal(frozen.policy, undefined, 'a fresh native freeze holds the bar alone [B4]');
    // A bar frozen by the previous release pinned its verify policy; replay keeps enforcing that pin (N-1).
    const legacyPolicy = { version: 1, commit, verify: { policy: 'coordinator', family: 'require' } };
    const legacyText = JSON.stringify({ ...frozen, policy: legacyPolicy });
    legacyDigest = createHash('sha256').update(legacyText).digest('hex');
    store.refreeze(source, 1, { agentId: 'coordinator', freeze: () => ({ text: legacyText, digest: legacyDigest }) });
  } finally { store.closeBoard(source); }

  runBuilder('claim', '1');
  const afterRefreeze = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  let document;
  let moves;
  try {
    const refreshed = store.getItem(afterRefreeze, 1);
    assert.deepEqual(JSON.parse(refreshed.item_frozen).policy.verify, { policy: 'coordinator', family: 'require' }, 'a renewal keeps the legacy pinned verify policy');
    assert.equal(refreshed.item_frozen_digest, legacyDigest, 'and its digest, so the legacy bar reads unchanged');
    submitFixture(afterRefreeze, 1, { agentId: builderId, commit, tree, files: [] });
    store.register(afterRefreeze, { lane: 'coordinator', path: box.root, family: 'Coordinator Family' });
    store.register(afterRefreeze, { lane, path: join(box.directory, 'verifier-same'), family: 'Builder Family', createdBy: 'coordinator' });
    verifierSame = store.agentAt(afterRefreeze, join(box.directory, 'verifier-same')).agent_id;
    store.register(afterRefreeze, { lane, path: join(box.directory, 'verifier-other'), family: 'Reviewer Family', createdBy: 'coordinator' });
    verifierOther = store.agentAt(afterRefreeze, join(box.directory, 'verifier-other')).agent_id;
    // These seats stand in for verifiers the coordinator enrolled through the relay (#579 standing).
    for (const seat of [verifierSame, verifierOther]) afterRefreeze.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`agent_enrolled:${seat}`, 'coordinator');

    /** Freeze test items with a specific historical policy document, keeping engine inputs deterministic. */
    const makeFrozen = (verify, version = 1) => item => {
      const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion, policy: { version, commit, ...(verify ? { verify } : {}) } });
      return { text, digest: createHash('sha256').update(text).digest('hex') };
    };
    /** Add, claim and submit one private fixture item with the supplied frozen verify values. */
    const makeSubmitted = (title, verify, version = 1) => {
      const id = store.addItem(afterRefreeze, { by: 'coordinator', lane, title });
      store.claim(afterRefreeze, id, { agentId: builderId, lane, leaseMs: 3_600_000, freeze: makeFrozen(verify, version), head: commit });
      submitFixture(afterRefreeze, id, { agentId: builderId, commit, tree, files: [] });
      return store.getItem(afterRefreeze, id);
    };
    const legacy = makeSubmitted('legacy frozen verify without policy capture', null);
    const sameFamily = makeSubmitted('require a different verifier family', { policy: 'any', family: 'require' });
    const crossFamily = makeSubmitted('allow a different verifier family', { policy: 'any', family: 'require' });
    const malformed = makeSubmitted('malformed captured verify policy', { policy: 'broken', family: 'off' });
    const wrongVersion = makeSubmitted('unsupported frozen policy version', { policy: 'any', family: 'require' }, 2);
    checkpointSequence(afterRefreeze, 0);
    document = JSON.parse(JSON.stringify(exportBoard(afterRefreeze)));
    /** Build a verifier envelope with deliberately untrusted any/off settings. */
    const forge = (item, agentId, id) => prepareEngineMove(afterRefreeze, 'verify', [item.item_id, {
      agentId, decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'checked by the fixture verifier',
      head: commit, digest: item.item_frozen_digest, policy: 'any', familyPolicy: 'off',
    }], { id });
    moves = [
      forge(refreshed, verifierSame, 'forged_coordinator_policy'),
      forge(legacy, verifierSame, 'missing_frozen_verify_policy'),
      forge(sameFamily, verifierSame, 'forged_family_policy'),
      forge(crossFamily, verifierOther, 'allowed_cross_family_verify'),
      forge(malformed, verifierSame, 'malformed_frozen_verify_policy'),
      forge(wrongVersion, verifierSame, 'unsupported_frozen_policy_version'),
      forge(refreshed, 'coordinator', 'compliant_legacy_refreeze_verify'),
    ];
  } finally { store.closeBoard(afterRefreeze); }

  const roots = [box.root, join(box.directory, 'second-policy-client')];
  const homes = [box.home, join(box.directory, 'second-policy-home')];
  const envs = homes.map(home => ({ ...box.env, HOME: home, PULLBOARD_HOME: home }));
  mkdirSync(roots[1]); mkdirSync(homes[1], { mode: 0o700 });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: roots[1], env: envs[1] }).status, 0);
  await initializeReplica(roots[1], envs[1]);
    const snapshotFile = join(box.directory, 'policy-snapshot.json');
  writeFileSync(snapshotFile, JSON.stringify(document), { mode: 0o600 });
  await replayClient(roots[1], envs[1], 'import', snapshotFile);
  const recipientConfig = JSON.parse(readFileSync(join(roots[1], 'pullboard.json'), 'utf8'));
  assert.notDeepEqual(recipientConfig.verify, { policy: 'coordinator', family: 'require' }, 'second client has different local settings from the frozen shared policy');
  for (let index = 0; index < roots.length; index += 1) {
    const keyDirectory = join(homes[index], 'relay-keys');
    mkdirSync(keyDirectory, { mode: 0o700 });
    writeFileSync(join(keyDirectory, box.id + '.key'), box.key.toString('base64url') + '\n', { mode: 0o600 });
    writeFileSync(join(roots[index], '.git/pullboard/relay.json'), JSON.stringify({ version: 1, mode: 'ordered', board: box.id, url: box.origin, repository: 'fixture/repository', token: box.machines[index].token, sequence: 0, cursor: document.tables.event.at(-1).event_id }) + '\n', { mode: 0o600 });
  }
  const snapshotSealed = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(document)), { boardId: box.id, kind: 'snapshot', sequence: 0 })).toString('base64url');
  const savedSnapshot = await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: snapshotSealed } });
  assert.equal(savedSnapshot.status, 200, 'person session installs the initial encrypted snapshot');
  const verifierTokens = new Map();
  for (const agent of new Set([verifierSame, verifierOther])) verifierTokens.set(agent, await box.auth.issueToken(box.machines[0].token, { board: box.id, agent }));
  for (let index = 0; index < moves.length; index += 1) {
    const agent = moves[index].args[1].agentId;
    const sequence = index + 1;
    const sealed = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(moves[index])), { boardId: box.id, kind: 'move', sequence })).toString('base64url');
    const token = agent === 'coordinator' ? box.person.token : verifierTokens.get(agent).token;
    const uploaded = await box.call(box.path + '/moves', { method: 'POST', token, body: { sequence, sealed } });
    assert.equal(uploaded.status, 200, 'the real relay accepts each authenticated verifier move as an opaque envelope');
  }

  const firstClient = await replayClientWithoutCheckpoint(roots[0], envs[0]);
  assert.equal(firstClient.code, 0);
  assert.equal(firstClient.checkpointWrites, 1, 'first client attempted one local checkpoint, suppressed before relay storage');
  const relayAfterFirst = await box.call(box.path + '/state');
  assert.equal(relayAfterFirst.body.state.sequence, 0, 'the second client cannot inherit the first client checkpoint');
  const secondClient = await replayClientWithoutCheckpoint(roots[1], envs[1]);
  assert.equal(secondClient.code, 0);
  assert.equal(secondClient.checkpointWrites, 1, 'second client independently attempted its own checkpoint');
  const exported = [firstClient.document, secondClient.document];
  assert.deepEqual(exported[0].tables, exported[1].tables, 'both real clients replay the same refusal and board prefix');
  assert.deepEqual(exported[0].tables.item.filter(item => ![1, 4].includes(item.item_id)), document.tables.item.filter(item => ![1, 4].includes(item.item_id)), 'policy refusals change no refused item state');
  assert.equal(exported[0].tables.item.find(item => item.item_id === 1).item_status, 'verified', 'a legacy pinned policy enables a compliant coordinator verification');
  assert.equal(exported[0].tables.item.find(item => item.item_id === 4).item_status, 'verified', 'a different declared family is allowed under the frozen require policy');
  assert.equal(exported[0].tables.verdict.length, document.tables.verdict.length + 2, 'only compliant coordinator and cross-family verifications create verdicts');
  const codes = ['forged_coordinator_policy', 'missing_frozen_verify_policy', 'forged_family_policy', 'malformed_frozen_verify_policy', 'unsupported_frozen_policy_version'];
  const outcomes = [];
  for (const result of exported) {
    assert.equal(result.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value, '7');
    outcomes.push(codes.map(id => JSON.parse(result.tables.board_meta.find(row => row.meta_key === 'relay_receipt_' + id).meta_value).outcome.error.code));
    const accepted = JSON.parse(result.tables.board_meta.find(row => row.meta_key === 'relay_receipt_allowed_cross_family_verify').meta_value);
    assert.equal(accepted.outcome.result.decision, 'ACCEPT');
    const refrozen = JSON.parse(result.tables.board_meta.find(row => row.meta_key === 'relay_receipt_compliant_legacy_refreeze_verify').meta_value);
    assert.equal(refrozen.outcome.result.decision, 'ACCEPT');
  }
  assert.deepEqual(outcomes, [
    ['COORDINATOR_VERIFIES', 'NO_POLICY', 'SAME_FAMILY', 'NO_POLICY', 'NO_POLICY'],
    ['COORDINATOR_VERIFIES', 'NO_POLICY', 'SAME_FAMILY', 'NO_POLICY', 'NO_POLICY'],
  ]);
});
