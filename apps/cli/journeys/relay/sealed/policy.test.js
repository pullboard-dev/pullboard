// pullboard: browser
/** @pullboard-test-gui */
/** Two real sealed clients enforce the verify policy captured in the item freeze [H16,O2]. */
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { fixture } from '../../../tests/fixtures/relay/sealed.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  runFixtureExecFile as execFileSync,
  runFixtureChild as spawnSync,
  cleanupFixtureChildren,
} from '../../../tests/fixtures/child.js';
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
import * as store from '../../../../../packages/store/index.js';
import { SPEC_REFREEZE } from '../../../../../packages/spec/index.js';
import { openBoard } from '../../../../lib/index.js';
import { main } from '../../../tests/fixtures/native.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import {
  checkpointSequence,
  prepareEngineMove,
} from '../../../../../packages/state/index.js';
import { seal as sealMove } from '../../../../../packages/kernel/index.js';
import {
  replayClient,
  initializeReplica,
  replayClientWithoutCheckpoint,
} from '../../../tests/fixtures/relay/sealed-client.js';

after(cleanupFixtureChildren);

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
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../../pullboard.js'), ...args, '--json'], { cwd: builder, env: box.env, encoding: 'utf8' });
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
    // A held claim is kept through a spec correction, so the builder's next claim is a renewal that keeps the pin.
    store.refreeze(source, 1, { agentId: 'coordinator', [SPEC_REFREEZE]: true, freeze: () => ({ text: legacyText, digest: legacyDigest }) });
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
