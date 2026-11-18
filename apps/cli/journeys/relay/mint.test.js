/** An agent in its worktree cannot mint a relay token or borrow another seat's verifier standing [H2,V1,E3,E5,P6] (#579). */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import {
  appliedSequence,
  applyRelayMove,
} from '../../../../packages/state/index.js';
import {
  ENGINE_VERSION,
  VERIFIER_STANDING_ENGINE,
} from '../../../../packages/state/index.js';
import { createRelayJournal } from '../../../relay/index.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

const TOKEN = /^pa_[A-Za-z0-9_-]{43}$/u;
const POLICY = { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } };

/** Run fixture Git with hooks off: this test is about relay credentials, not the installed hooks. */
function git(root, env, args) {
  const result = runFixtureChild('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure ?? `fixture git ${args[0]} succeeds`);
  return result.stdout.trim();
}

/** Send one credentialed request to the loopback relay; bearer values never enter a message. */
async function call(origin, token, method, path, body) {
  const response = await fetch(origin + path, {
    method, headers: { authorization: `Bearer ${token}`, 'x-pullboard-engine': String(ENGINE_VERSION),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, document: await response.json() };
}

/** Read the shared link file every worktree of this repository can read. */
function link(box) { return JSON.parse(readFileSync(box.linkFile, 'utf8')); }

/** Every file under a directory, for a scan that no person session sits on disk (#299). */
function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

/** Freeze a criterion with a valid verify policy, as the CLI does at claim. */
function freezer() {
  const text = JSON.stringify({ criterion: 'an independent seat accepts it', policy: POLICY });
  return () => ({ text, digest: createHash('sha256').update(text).digest('hex') });
}

/**
 * Create synthetic submitted history for the credential test; this fixture does not run a gate.
 * A file board binds its repository only while it seals the submit; replayed relay moves run without one.
 */
function submitted(board, builder, lane, gitRoot) {
  const added = store.addItem(board, { by: 'coordinator', lane, title: 'provenance review', criterion: 'an independent seat accepts it' });
  const item = { item_id: typeof added === 'number' ? added : added.item_id };
  store.claim(board, item.item_id, { agentId: builder, lane, leaseMs: 3_600_000, freeze: freezer(), head: 'a'.repeat(40) });
  if (gitRoot) board.gitRoot = gitRoot;
  try { submitFixture(board, item.item_id, { agentId: builder, commit: 'b'.repeat(40), tree: 'c'.repeat(40) }); } finally { if (gitRoot) board.gitRoot = undefined; }
  return store.getItem(board, item.item_id);
}

test('cli.journeys-relay-mint.an-agent-in-its-worktree-cannot: an agent in its worktree cannot mint a relay token [H2,V1,E3,E5,P6]', async (t) => {
  const box = await relayClientFixture(t);
  const lane = box.lane;
  git(box.root, box.env, ['add', '-A']);
  git(box.root, box.env, ['commit', '-q', '-m', 'test: private relay mint fixture']);
  const head = git(box.root, box.env, ['rev-parse', 'HEAD']);

  // A seat the coordinator made before the board was linked: it builds, but it was never enrolled.
  const prelinked = await box.cliLocal('worktree', lane, '--model', 'Prelinked Seat');
  assert.equal(prelinked.code, 0, prelinked.failure ?? 'the unlinked coordinator makes a worktree');
  await box.link();
  const start = link(box);
  assert.match(start.agentTokens?.coordinator?.token ?? '', TOKEN, 'relay on sets up the coordinator token from the person sign-in');
  const session = await call(box.origin, start.agentTokens.coordinator.token, 'GET', `/auth/session?board=${start.board}`);
  assert.equal(session.document.session.root, true, 'the coordinator token is the person-made root');

  // A manual join: no seat made it, so the machine credential gives it a build-only token, with no person action.
  const manualRoot = join(dirname(box.root), 'manual-join');
  git(box.root, box.env, ['worktree', 'add', '-q', '--detach', manualRoot, head]);
  const before = box.transit.length;
  const manualJoin = await box.cliAtLocal(manualRoot, 'join', lane, '--model', 'Manual Seat');
  assert.equal(manualJoin.code, 0, manualJoin.failure ?? 'a manual join enrolls with no person action');
  const manual = manualJoin.document.agent;
  const manualTraffic = box.transit.slice(before);
  const manualMint = manualTraffic.find((entry) => entry.method === 'POST' && entry.path === '/auth/tokens');
  assert.equal(JSON.parse(manualMint.request.toString('utf8')).agent, manual, 'the machine credential first-mints the manual seat');
  assert.match(JSON.parse(manualMint.response.toString('utf8')).token ?? '', TOKEN);
  assert.equal(manualTraffic.some((entry) => /approvals|authorize|\/auth\/device/u.test(entry.path)), false, 'no phone or person step');

  // Fresh seats from their creators: the first token comes back in the creator's own registration request.
  /** Make one seat from a creator's checkout and return its id, path and registration exchange. */
  const created = async (cwd, model) => {
    const from = box.transit.length;
    const result = cwd === box.root ? await box.cliLocal('worktree', lane, '--model', model) : await box.cliAtLocal(cwd, 'worktree', lane, '--model', model);
    assert.equal(result.code, 0, result.failure ?? `the creator makes ${model}`);
    const traffic = box.transit.slice(from);
    const registration = traffic.findLast((entry) => entry.method === 'POST' && entry.path.endsWith('/moves') && JSON.parse(entry.request.toString('utf8')).registration
      && JSON.parse(entry.response.toString('utf8')).enrollment);
    assert.ok(registration, 'the registration move carries its seat receipt');
    const reply = JSON.parse(registration.response.toString('utf8'));
    assert.equal(reply.enrollment.agent, result.document.agent, 'the registration reply enrolls the new seat');
    assert.match(reply.enrollment.token ?? '', TOKEN, 'its creator receives the first token in that same request');
    assert.equal(reply.event.registration.target, result.document.agent, 'the public event names the target');
    assert.equal(JSON.stringify(reply.event).includes(reply.enrollment.token), false, 'the token never enters the public event');
    assert.equal(traffic.some((entry) => entry.method === 'POST' && entry.path === '/auth/tokens'), false, 'no separate first mint');
    assert.equal(traffic.some((entry) => /approvals|authorize|\/auth\/device/u.test(entry.path)), false, 'enrollment stays zero-tap');
    return { id: result.document.agent, path: result.document.path, registration };
  };
  const builder = await created(box.root, 'Builder Seat');
  const reviewer = await created(box.root, 'Reviewer Seat');
  const child = await created(builder.path, 'Child Seat');
  const grandchild = await created(child.path, 'Grandchild Seat');
  const prelinkedActs = await box.cliAtLocal(prelinked.document.path, 'shout', 'all', 'a seat from before the link keeps building');
  assert.equal(prelinkedActs.code, 0, prelinkedActs.failure ?? 'an existing seat keeps working after the link');

  const boardCopy = join(mkdtempSync(join(tmpdir(), 'pullboard-mint-board-')), 'board.sqlite');
  t.after(() => rmSync(dirname(boardCopy), { recursive: true, force: true }));
  copyFileSync(join(box.root, '.git', 'pullboard', 'board.sqlite'), boardCopy);
  const board = openBoard(boardCopy);
  t.after(() => store.closeBoard(board));
  assert.equal(store.agentCreator(board, manual), 'machine', 'a manual join records that no seat made it');
  assert.equal(store.agentCreator(board, builder.id), 'coordinator');
  assert.equal(store.agentCreator(board, reviewer.id), 'coordinator');
  assert.equal(store.agentCreator(board, child.id), builder.id, 'every registration records the seat that created it');
  assert.equal(store.agentCreator(board, grandchild.id), child.id);
  assert.equal(store.seatEnrolled(board, child.id), true);
  assert.equal(store.seatEnrolled(board, manual), false);
  assert.equal(store.seatEnrolled(board, prelinked.document.agent), false, 'a seat made before linking was never enrolled');

  await t.test('every credential a worktree can reach is refused against every existing seat', async () => {
    const state = link(box);
    const shared = readFileSync(box.linkFile, 'utf8');
    for (const path of [box.linkFile, ...files(join(box.root, '.git', 'pullboard')), ...files(box.env.PULLBOARD_HOME), ...files(box.env.PULLBOARD_MACHINE_HOME)]) {
      if (statSync(path).size < 2_000_000) assert.equal(/ps_[A-Za-z0-9_-]{43}/u.test(readFileSync(path, 'latin1')), false, 'no person session is stored where a worktree can read it');
    }
    assert.match(state.token, /^pm_[A-Za-z0-9_-]{43}$/u, 'the shared link file holds the machine credential');
    const seats = Object.keys(state.agentTokens);
    for (const seat of ['coordinator', manual, prelinked.document.agent, builder.id, reviewer.id, child.id, grandchild.id]) assert.ok(seats.includes(seat), `${seat} has a cached token`);
    assert.equal(seats.length, store.listAgents(board).length, 'every registered seat holds a token');
    const credentials = [['machine', state.token], ...seats.map((seat) => [seat, state.agentTokens[seat].token])];
    const copied = JSON.parse(builder.registration.request.toString('utf8')).registration;
    let attempts = 0;
    for (const [holder, credential] of credentials) {
      for (const target of seats) {
        if (holder === target) continue; // A seat's own token renewing itself is the one decided exception (7bbf20c0).
        for (const body of [{ board: state.board, agent: target }, { board: state.board, agent: target, recover: true }, { board: state.board, agent: target, registration: copied }]) {
          if (body.recover && holder === 'coordinator' && [builder.id, reviewer.id].includes(target)) continue; // Its creator's reissue.
          if (body.recover && holder === builder.id && target === child.id) continue;
          if (body.recover && holder === child.id && target === grandchild.id) continue;
          const attempt = await call(box.origin, credential, 'POST', '/auth/tokens', body);
          attempts += 1;
          assert.ok(attempt.status >= 400, `${holder} cannot mint for ${target}`);
          assert.ok(['TOKEN_EXISTS', 'TOKEN_AGENT', 'REGISTRATION_IN_MOVE'].includes(attempt.document.error?.code), `${holder} is refused by name for ${target}`);
        }
      }
      const root = await call(box.origin, credential, 'POST', '/auth/coordinators', { board: state.board });
      assert.equal(root.status, 403, `${holder} cannot set up the coordinator credential`);
      assert.equal(root.document.error?.code, 'HUMAN_REQUIRED');
    }
    assert.ok(attempts > 90, 'the sweep covers every reachable credential against every existing seat');
    assert.equal(readFileSync(box.linkFile, 'utf8'), shared, 'no refused attempt changed the shared link file');
  });

  await t.test('a seat renews only with its own token, and only its creator reissues a lost one', async () => {
    const state = link(box);
    const own = state.agentTokens[grandchild.id].token;
    const renewed = await call(box.origin, own, 'POST', '/auth/tokens', { board: state.board, agent: grandchild.id });
    assert.equal(renewed.status, 201, 'the current token renews its own seat');
    assert.equal((await call(box.origin, own, 'GET', `/auth/session?board=${state.board}`)).status, 401, 'renewal revokes the old token');
    assert.equal((await call(box.origin, renewed.document.token, 'GET', `/auth/session?board=${state.board}`)).document.session.agent, grandchild.id);
    const reissued = await call(box.origin, state.agentTokens[child.id].token, 'POST', '/auth/tokens', { board: state.board, agent: grandchild.id, recover: true });
    assert.equal(reissued.status, 201, 'the creator reissues a lost token');
    assert.equal((await call(box.origin, renewed.document.token, 'GET', `/auth/session?board=${state.board}`)).status, 401, 'reissue revokes the old one');
    // Once every token of a seat is revoked or expired, the machine credential still cannot renew it.
    const person = await box.phoneSession();
    await box.auth.revoke(person.token, reissued.document.id);
    const machineRenewal = await call(box.origin, state.token, 'POST', '/auth/tokens', { board: state.board, agent: grandchild.id });
    assert.equal(machineRenewal.document.error?.code, 'TOKEN_EXISTS', 'the machine credential never renews a registered seat that held a token');
    // A machine-minted seat has no receipt to fall back on: its first-mint history alone refuses.
    await box.auth.revoke(person.token, state.agentTokens[prelinked.document.agent].id);
    const machineRemint = await call(box.origin, state.token, 'POST', '/auth/tokens', { board: state.board, agent: prelinked.document.agent });
    assert.equal(machineRemint.document.error?.code, 'TOKEN_EXISTS', 'the machine credential never renews a seat that held a token');
    const manualRecover = await call(box.origin, state.agentTokens[manual].token, 'POST', '/auth/tokens', { board: state.board, agent: manual, recover: true });
    assert.equal(manualRecover.document.error?.code, 'TOKEN_AGENT', 'a machine-origin seat has no creator to reissue it');
    // Retrying the exact registration returns the same issuance, and no token.
    const first = JSON.parse(reviewer.registration.response.toString('utf8')).enrollment;
    const retry = await call(box.origin, state.agentTokens.coordinator.token, 'POST', reviewer.registration.path, JSON.parse(reviewer.registration.request.toString('utf8')));
    assert.equal(retry.status, 200, 'an exact registration retry is accepted');
    assert.equal(retry.document.enrollment.id, first.id, 'it returns the same issuance');
    assert.equal(retry.document.enrollment.expires, first.expires);
    assert.equal(retry.document.enrollment.token, undefined, 'the relay holds no token to return');
  });

  await t.test('a machine-origin seat stays build-only and its name cannot be registered', async () => {
    const state = link(box);
    const sealed = Buffer.from('opaque fixture move').toString('base64url');
    const registration = { target: manual, creator: builder.id, sequence: state.sequence + 1, digest: createHash('sha256').update(sealed).digest('hex') };
    const later = await call(box.origin, state.agentTokens[builder.id].token, 'POST', `/api/v1/boards/${state.board}/moves`, { sequence: registration.sequence, sealed, registration });
    assert.equal(later.document.error?.code, 'SEAT_TAKEN', 'registering a machine-minted name is refused, not upgraded');
    // A pre-mint of the next name makes the creator take the one after it, still with no person action.
    const target = store.nextSeatId(board, lane);
    const premint = await call(box.origin, state.token, 'POST', '/auth/tokens', { board: state.board, agent: target });
    assert.equal(premint.status, 201, 'the machine credential first-mints a never-issued name');
    const skipped = await created(box.root, 'After Premint');
    assert.notEqual(skipped.id, target, 'the pre-minted name is skipped, not upgraded');
    const claimed = await box.cliAtLocal(manualRoot, 'shout', 'all', 'manual seat still builds');
    assert.equal(claimed.code, 0, claimed.failure ?? 'the build-only seat keeps acting under its own token');
  });

  await t.test('a registration interrupted before enrollment still claims its seat from the machine', async () => {
    // Causal control for the 5e76ff75 reject: fail after the journal append, before enrollment.
    const enroll = box.auth.enrollSeat;
    let injected = 0;
    box.auth.enrollSeat = (...args) => {
      if (injected++ === 0) throw new Error('injected failure between the journal append and enrollment');
      return enroll.apply(box.auth, args);
    };
    const from = box.transit.length;
    let interrupted;
    try { interrupted = await box.cliLocal('worktree', lane, '--model', 'Interrupted Seat'); }
    finally { box.auth.enrollSeat = enroll; }
    assert.notEqual(interrupted.code, 0, 'the creator sees the failed registration');
    const failed = box.transit.slice(from).find((entry) => entry.method === 'POST' && entry.path.endsWith('/moves') && JSON.parse(entry.request.toString('utf8')).registration);
    assert.ok(failed, 'the registration reached the relay');
    const body = JSON.parse(failed.request.toString('utf8'));
    const state = link(box);
    const snapshot = await call(box.origin, state.token, 'GET', `/api/v2/boards/${state.board}/state`);
    const events = await call(box.origin, state.token, 'GET', `/api/v1/boards/${state.board}/events?after=${snapshot.document.state.sequence}`);
    assert.equal(events.status, 200, JSON.stringify(events.document.error ?? {}));
    assert.ok(events.document.events.some((event) => event.registration?.target === body.registration.target), 'the move and its receipt were published');
    assert.equal(box.auth.seatRecord(state.board, body.registration.target), null, 'no first-issuance history was written');
    const race = await call(box.origin, state.token, 'POST', '/auth/tokens', { board: state.board, agent: body.registration.target });
    assert.equal(race.document.error?.code, 'TOKEN_EXISTS', 'the machine credential cannot first-mint a name its published receipt claims');
    const retry = await call(box.origin, state.agentTokens.coordinator.token, 'POST', failed.path, body);
    assert.equal(retry.status, 200, 'the creator\'s exact retry is accepted');
    assert.equal(retry.document.enrollment.agent, body.registration.target);
    assert.match(retry.document.enrollment.token ?? '', TOKEN, 'the exact retry finishes the enrollment with the first token');
    assert.equal(box.auth.seatRecord(state.board, body.registration.target).origin, 'registered');
    const after = await call(box.origin, state.token, 'POST', '/auth/tokens', { board: state.board, agent: body.registration.target });
    assert.equal(after.document.error?.code, 'TOKEN_EXISTS');
  });

  await t.test('linked verify refuses the builder line and seats without standing, in one line', () => {
    const item = submitted(board, builder.id, lane, box.root);
    /** The accept arguments a seat sends for this item. */
    const verdict = (agentId) => [item.item_id, { agentId, decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'checked the proof', head: 'd'.repeat(40), digest: item.item_frozen_digest }];
    let id = 0;
    /** Replay one current-engine move with the engine-48 standing policy on the linked board copy. */
    const move = (operation, args, sender, extra = {}) => applyRelayMove(board, { version: 1, engine: ENGINE_VERSION, id: `standing-${++id}`, operation, args }, {
      sequence: appliedSequence(board) + 1, at: new Date().toISOString(), kind: 'move', sender: { kind: 'agent', userId: '1', policy: VERIFIER_STANDING_ENGINE, ...sender }, ...extra,
    });
    for (const seat of [child.id, grandchild.id, manual, prelinked.document.agent]) {
      const refused = move('verify', verdict(seat), { agent: seat });
      assert.equal(refused.error?.code, 'VERIFIER_STANDING', `${seat} has no verifier standing on the linked board`);
      assert.equal(refused.error.message.includes('\n'), false, 'the refusal is one line');
      assert.match(refused.error.message, /pullboard worktree <lane> --model "<model name>"/u, 'it names the coordinator command');
    }
    assert.equal(move('verify', verdict(builder.id), { agent: builder.id }).error?.code, 'SELF_VERIFY');
    assert.equal(move('verify', verdict('coordinator'), { agent: 'coordinator' }).error?.code, 'VERIFIER_STANDING', 'a coordinator token the person did not set up has no standing');
    const next = move('reserveNextReview', [{ agentId: child.id, lane, leaseMs: 60_000, policy: 'any' }], { agent: child.id });
    assert.equal(next.result.item, null, 'next --verify offers the builder\'s child nothing');
    assert.match(next.result.reasons.join('\n'), /pullboard worktree <lane> --model/u);
    const forged = move('register', [{ lane, path: '/forged-seat', model: 'Forged', createdBy: builder.id, id: `${lane}-900` }], { agent: builder.id });
    assert.equal(forged.error?.code, 'RELAY_REGISTRATION', 'a seat registered without its relay receipt is refused');
    const accepted = move('verify', verdict(reviewer.id), { agent: reviewer.id });
    assert.equal(accepted.result?.decision, 'ACCEPT', 'a seat the coordinator made outside the builder line verifies');
    // The literal rule holds for the coordinator too (decision 11096): its seats share its lineage.
    const own = submitted(board, 'coordinator', 'coordinator', box.root);
    const ownVerdict = move('verify', [own.item_id, { ...verdict(reviewer.id)[1], digest: own.item_frozen_digest }], { agent: reviewer.id });
    assert.equal(ownVerdict.error?.code, 'VERIFIER_STANDING', 'a coordinator-made seat cannot verify the coordinator\'s own work');
    assert.match(ownVerdict.error.message, /another machine's registration lineage, or the person/u);

    // The positive half of 11099: the coordinator on machine A builds; a seat from machine B's
    // registration lineage, or the person, verifies it, while machine A's own seats still cannot.
    const machineA = { agent: 'coordinator', root: true, lineage: '11111111-1111-4111-8111-111111111111' };
    const machineB = { agent: 'coordinator', root: true, lineage: '22222222-2222-4222-8222-222222222222' };
    /** Enroll one seat through a replayed, receipt-bound coordinator registration from one machine. */
    const enrollFrom = (sender, n) => {
      const target = `${lane}-${n}`;
      const digest = String(n % 10).repeat(64);
      const sequence = appliedSequence(board) + 1;
      const made = move('register', [{ lane, path: `/lineage-seat-${n}`, model: 'Lineage Seat', createdBy: 'coordinator', id: target }], sender,
        { registration: { target, creator: 'coordinator', sequence, digest }, digest });
      assert.equal(made.result, target, `machine ${sender.lineage.slice(0, 1)} enrolls ${target}`);
      return target;
    };
    const seatA = enrollFrom(machineA, 801);
    const seatB = enrollFrom(machineB, 802);
    /** Claim and submit one coordinator item through replayed moves from machine A. */
    const builtOnA = () => {
      const itemId = store.addItem(board, { by: 'coordinator', lane: 'coordinator', title: 'coordinator-built on machine A', criterion: 'another lineage accepts it' });
      const frozen = freezer()();
      assert.equal(move('claim', [itemId, { agentId: 'coordinator', lane: 'coordinator', leaseMs: 3_600_000, head: 'a'.repeat(40), frozen, freezeError: null }], machineA).error, undefined);
      // Synthetic relay history names its deferred coverage; it does not claim a gate ran.
      assert.equal(move('submit', [itemId, { agentId: 'coordinator', commit: 'b'.repeat(40), tree: 'c'.repeat(40),
        submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'synthetic relay history; no gate execution' },
      }], machineA).error, undefined);
      return store.getItem(board, itemId);
    };
    const coordinatorItem = builtOnA();
    const accept = (item) => [item.item_id, { agentId: seatB, decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'checked the proof', head: 'd'.repeat(40), digest: item.item_frozen_digest }];
    const sameLine = move('verify', [coordinatorItem.item_id, { ...accept(coordinatorItem)[1], agentId: seatA }], { agent: seatA });
    assert.equal(sameLine.error?.code, 'VERIFIER_STANDING', 'a seat from the building machine\'s own lineage is refused');
    const otherMachine = move('verify', accept(coordinatorItem), { agent: seatB });
    assert.equal(otherMachine.result?.decision, 'ACCEPT', 'a seat from another machine\'s registration lineage verifies coordinator-built work');
    const forPerson = builtOnA();
    const person = move('verify', [forPerson.item_id, { ...accept(forPerson)[1], agentId: seatA }], { kind: 'person', agent: undefined });
    assert.equal(person.result?.decision, 'ACCEPT', 'the person verifies coordinator-built work');
  });

  // 19 (bar corrections, #470) and 20 (implies, #469) are main's engines before #579; their journals replay as they did too.
  for (const engine of [11, 12, 19, 20]) await t.test(`an engine-${engine} journal replays as before`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), `pullboard-mint-engine${engine}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const historical = openBoard(':memory:');
    t.after(() => store.closeBoard(historical));
    historical.executionEngineVersion = engine;
    store.register(historical, { lane: 'coordinator', path: '/repo' });
    const legacyBuilder = store.register(historical, { lane: 'web', path: '/repo-web-1', createdBy: 'machine' });
    const legacyReviewer = store.register(historical, { lane: 'web', path: '/repo-web-2' });
    delete historical.executionEngineVersion;
    assert.equal(store.agentCreator(historical, legacyBuilder), null, `engine ${engine} records no provenance`);
    const item = submitted(historical, legacyBuilder, 'web');
    const recorded = { version: 1, engine, id: `engine-${engine}-verify`, operation: 'verify',
      args: [item.item_id, { agentId: legacyReviewer, decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'checked', head: 'd'.repeat(40), digest: item.item_frozen_digest }] };
    const boardId = 'e'.repeat(32);
    const path = join(directory, boardId + '.journal.sqlite');
    const db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    db.exec(`CREATE TABLE journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE journal_record (sequence INTEGER PRIMARY KEY, received_at TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('move','request')),
        payload BLOB NOT NULL, sender_kind TEXT NOT NULL CHECK(sender_kind IN ('person','agent','machine')), sender_user TEXT NOT NULL, sender_agent TEXT);
      CREATE TABLE journal_head (slot INTEGER PRIMARY KEY CHECK(slot=1), sequence INTEGER NOT NULL, last_activity_at TEXT);
      CREATE TABLE journal_snapshot (slot INTEGER PRIMARY KEY CHECK(slot=1), sequence INTEGER NOT NULL, received_at TEXT NOT NULL, payload BLOB NOT NULL,
        sender_kind TEXT NOT NULL, sender_user TEXT NOT NULL, sender_agent TEXT);`);
    db.prepare('INSERT INTO journal_meta (key,value) VALUES (?,?),(?,?)').run('board', boardId, 'format', '3');
    db.prepare("INSERT INTO journal_record VALUES (1,'2026-10-08T10:00:00.000Z','move',?,'agent','202',?)").run(Buffer.from(JSON.stringify(recorded)), legacyReviewer);
    db.prepare("INSERT INTO journal_head VALUES (1,1,'2026-10-08T10:00:00.000Z')").run();
    db.close();
    const journal = createRelayJournal({ directory, boardId });
    const [record] = journal.after();
    journal.close();
    assert.deepEqual(record.sender, { kind: 'agent', userId: '202', agent: legacyReviewer }, `the engine-${engine} record gains no stamp`);
    assert.equal(record.registration, undefined);
    assert.deepEqual(JSON.parse(record.bytes.toString('utf8')), recorded, 'its move bytes are unchanged');
    const fresh = openBoard(':memory:');
    t.after(() => store.closeBoard(fresh));
    const stamped = applyRelayMove(fresh, recorded, { sequence: 1, at: record.receivedAt, kind: 'move',
      sender: { ...record.sender, policy: VERIFIER_STANDING_ENGINE } });
    assert.equal(stamped.error?.code, 'ENGINE_VERSION', 'a newly stored record cannot claim an old engine');
    const replayed = applyRelayMove(historical, JSON.parse(record.bytes.toString('utf8')), { sequence: 1, at: record.receivedAt, kind: record.kind, sender: record.sender });
    assert.equal(replayed.error, undefined, `the engine-${engine} verdict replays with its old rules`);
    assert.equal(replayed.result.decision, 'ACCEPT');
  });

  await t.test('an unlinked board verifies exactly as before', (t) => {
    const local = openBoard(':memory:');
    t.after(() => store.closeBoard(local));
    store.register(local, { lane: 'coordinator', path: '/repo' });
    const localBuilder = store.register(local, { lane: 'web', path: '/repo-web-1', createdBy: 'machine' });
    const localReviewer = store.register(local, { lane: 'web', path: '/repo-web-2', createdBy: 'machine' });
    const item = submitted(local, localBuilder, 'web');
    const result = store.verify(local, item.item_id, { agentId: localReviewer, decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'checked the proof',
      head: 'd'.repeat(40), digest: item.item_frozen_digest, policy: 'any' });
    assert.equal(result.decision, 'ACCEPT', 'an existing seat verifies another builder\'s item with no standing check');
    assert.equal(store.reviewOffer(local, { agentId: localReviewer, lane: 'web', ratio: 0 }), null, 'nothing left to review');
  });
});
