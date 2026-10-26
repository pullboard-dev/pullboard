/** @pullboard-test-loads src/board.js src/engine.js src/exchange.js */
/** Two independent Git/SQLite replicas derive verdict freshness without rewriting proof [E8]. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync, lstatSync, renameSync, symlinkSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { applyEngineMove, prepareEngineMove } from '../src/engine.js';
import { relayClientFixture as sessionRelay, relayFixtureChild as sessionChild, relayClientFixture, relayFixtureChild } from './relay-client-fixture.js';
import { runFixtureGit as sessionGit, runFixtureGit, runFixtureChild } from './fixture-child.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { serveApi } from '../src/api.js';
import { main } from '../src/cli.js';
import { fetchFresh } from './http-fixture.js';
import { relaySnapshot, presentationDigest } from '../src/relay-presentation.js';
import { snapshotState } from '../relay/browser-model.js';
import { unpackRelease } from './release-archive.js';
import { decodeBoardKey, seal } from '../src/seal.js';
import { ENGINE_VERSION as PEOPLE_VERSION } from '../src/machine.js';
import { relayWorkBudgetMs } from './relay-budget.js';
import { hostname, tmpdir } from 'node:os';
import { createDeviceKeys, unwrapDeviceBoardKey } from '../src/relay-device-keys.js';
import { handOverBoardKeys, statementBytes } from '../src/relay-handover.js';
import { signSshVouch } from '../src/relay-ssh-proof.js';
import { assertMatchingLandingHost, assertNoCulpritTrunkHold } from './landing-environment-fixture.js';
import { landingQueueCase } from './landing-queue-fixture.js';
import {
  prepareKeylessInbox,
  readKeylessInbox,
  finishKeylessInbox,
} from './inbox-key-fixture.js';

const CLI = join(import.meta.dirname, '..', 'bin', 'pullboard.js');

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('land runs on a matching host [E27,E28,E29]', { timeout: 180_000 }, () => { // budget: hang ceiling for real Git/CLI host checks, bisection and waiver controls; no speed target.
  assertMatchingLandingHost(helpers);
  assertNoCulpritTrunkHold(helpers);
});
test('a trunk lands one batch at a time [B3,R3,Q1,Q2,E8]', { timeout: 120_000 }, // budget: hang ceiling for real private Git, CLI checks, both gate barriers and cleanup; no speed target.
  async t => landingQueueCase(t, helpers));

test('a queued landing uses admitted policy and repairs before pinning it [Q1,B3]', { timeout: 120_000 }, // budget: two real CLI landings and bounded recorded-tip repair, not a speed threshold.
  async t => landingQueueCase(t, helpers, { policyAfterFirst: true }));

test('a queued landing rechecks freshness after its holder moves main [E8,Q1,Q2]', { timeout: 120_000 }, // budget: real private Git/CLI and deterministic gate barrier; no speed target.
  async t => landingQueueCase(t, helpers, { staleAfterFirst: true }));

test('an abandoned landing drains its blocked gate before adoption [Q1,Q3,B3]', { timeout: 120_000 }, // budget: private CLI death, owned-process cleanup, interrupted-batch adoption and Git; no speed target.
  async t => landingQueueCase(t, helpers, { killParent: true }));

test('a dead landing guardian cannot leave its blocked worker running [Q1,Q3,B3]', { timeout: 120_000 }, // budget: private guardian death, identity-bound cleanup and explicit adoption; no speed target.
  async t => landingQueueCase(t, helpers, { killGuardian: true }));

test('a suspended landing owner is fenced before the queued adopter runs [Q1,Q3]', { timeout: 120_000 }, // budget: real 30s authority expiry, independent guardian watchdog, cleanup and adoption; no speed target.
  async t => landingQueueCase(t, helpers, { suspendParent: true }));

/** Open a fixture's independent board and always close it after its observation or public move. */
function withBoard(root, action) {
  const board = store.openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  try { return action(board); }
  finally { store.closeBoard(board); }
}

/** Run a real fixture CLI command, retaining the refusal or successful document verbatim. */
function run(box, root, ...args) {
  const result = box.run(root, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
  return result.out;
}

/** Occupy this fixture's actual gate until its stale re-review enters the ordinary queue. */
async function holdForReviewQueue(box) {
  const ready = join(box.dir, 'review-gate-held');
  const observed = join(box.dir, 'review-was-queued');
  const source = `
import {setTimeout as pause} from 'node:timers/promises';
import {writeFileSync} from 'node:fs';
import {takeResource,listResources} from ${JSON.stringify(new URL('../src/resources.js', import.meta.url).href)};
import {loadMachineSettings} from ${JSON.stringify(new URL('../src/settings.js', import.meta.url).href)};
const [root,ready,observed]=process.argv.slice(1);
const capacity=loadMachineSettings().gateSlots;
const leases=[];
let stopping=false;
process.once('SIGTERM',()=>{stopping=true;});
try {
  for(let i=0;i<capacity;i++) leases.push(await takeResource({name:'gate',capacity,scope:'machine',root,agent:'stale-review-fixture-holder',browser:false}));
  writeFileSync(ready,'all ordinary slots really held');
  const deadline=Date.now()+30_000;
  while(!stopping) {
    const gate=listResources({root}).find(entry=>entry.name==='gate');
    if(gate?.line.some(entry=>entry.item==='1'&&entry.kind==='review')) {writeFileSync(observed,'the real review waiter was observed');break;}
    if(Date.now()>=deadline) throw Error('the stale review never entered the actual private gate queue');
    await pause(20);
  }
} finally {for(const lease of leases.reverse()) lease.release();}
`;
  const holder = helpers.launch(box, box.repo, process.execPath, ['--input-type=module', '-e', source, box.repo, ready, observed]);
  const deadline = Date.now() + 10_000;
  try {
    while (!existsSync(ready)) {
      assert.equal(holder.exitCode, null, holder.failure ?? holder.stderrText);
      assert.ok(Date.now() < deadline, 'the real private gate holder becomes ready');
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
  } catch (error) {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGTERM');
    await holder.closed;
    throw error;
  }
  return { holder, observed };
}

test('a verdict reads stale when main moves under its files [E8]', { timeout: 120_000 }, async t => { // budget: hang ceiling for two real replicas, CLI checks and Git history; not a speed target.
  const box = helpers.project();
  assert.equal(helpers.commitFile(box, box.repo, 'web/feature.js', 'feature = 0\nmain = 0\n', 'feat(web): baseline [G1]').status, 0);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const checkedHeads = join(box.dir, 'checked-heads');
  const check = `grep -q '^feature = 1$' web/feature.js && git rev-parse HEAD >> '${checkedHeads}'`;
  run(box, box.repo, 'add', 'web', 'Feature', '--specs', 'G1', '--check', check, '--wait');
  run(box, box.web, 'claim', '1');
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.js', 'feature = 1\nmain = 0\n', 'feat(web): feature [G1]').status, 0);
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  run(box, box.web, 'submit', '1');
  const reviewer = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
  run(box, reviewer, 'join', 'web');
  run(box, reviewer, 'next', '--verify', '1');
  run(box, reviewer, 'verify', '1', 'accept', '--note', 'The feature changes its first line and the frozen check observes it.');
  assert.equal(withBoard(box.repo, board => store.getItem(board, 1)).item_review_by,
    withBoard(box.repo, board => store.getItem(board, 1)).item_verified_by,
    'the original reservation stays in history after acceptance; it is not a live review lease');
  const original = withBoard(box.repo, board => store.verdictsFor(board, 1));
  const mainEditor = join(box.dir, 'main-caller-editor');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', mainEditor, 'main');
  run(box, mainEditor, 'join', 'web');
  const peer = join(box.dir, 'replica');
  box.git(box.dir, 'clone', '-q', box.repo, peer);
  withBoard(peer, board => importBoard(board, withBoard(box.repo, exportBoard)));

  /** Move only the peer's Git trunk; its independently stored acceptance stays unchanged. */
  const syncTrunk = () => {
    box.git(peer, 'fetch', '-q', 'origin', 'main');
    box.git(peer, 'merge', '-q', '--ff-only', 'origin/main');
  };
  /** Read each replica through its actual public CLI, rather than a test-only freshness helper. */
  const items = () => [box.repo, peer].map(root => JSON.parse(run(box, root, 'show', '1', '--json')));
  let streamController;
  let streamReader;
  let builds = 0;
  const api = await serveApi({ runCommand: main, projects: () => [{ root: reviewer, name: 'Verdict fixture' }], onStateBuild: () => { builds += 1; } });
  t.after(async () => {
    streamController?.abort();
    await streamReader?.cancel().catch(() => {});
    await api.close();
  });
  const address = new URL(api.url);
  const headers = { 'x-pullboard-key': address.searchParams.get('k') };
  const apiPath = '/api/v1/boards/' + withBoard(box.repo, store.boardId);
  /** Read one authenticated public HTTP endpoint on the persistent worktree-backed server. */
  const http = async suffix => {
    const response = await fetchFresh(address.origin + apiPath + suffix, { headers });
    const document = await response.json();
    assert.equal(response.status, 200, JSON.stringify(document));
    return document;
  };
  const initialState = (await http('/state')).state;
  const phoneBefore = relaySnapshot(reviewer);
  await http('/state');
  assert.equal(builds, 1, 'unchanged HTTP reads reuse the state cache');
  await http('/items/1'); // Warm the independent detail freshness projection for a verified item.
  const processMethods = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'];
  const originals = new Map(processMethods.map(method => [method, childProcess[method]]));
  const processCalls = [];
  try {
    for (const method of processMethods) childProcess[method] = function (...args) {
      processCalls.push({ method, command: args[0] });
      return Reflect.apply(originals.get(method), this, args);
    };
    syncBuiltinESMExports();
    await http('/items/1');
    await http('/state');
    await http('/items/1');
    relaySnapshot(reviewer);
    relaySnapshot(reviewer);
    assert.deepEqual(processCalls, [], 'unchanged accepted-item detail, state and sealed phone snapshot reads spawn no process');
  } finally {
    for (const [method, original] of originals) childProcess[method] = original;
    syncBuiltinESMExports();
  }

  assert.ok(items().every(item => !item.item_verdict_state));
  assert.equal(helpers.commitFile(box, mainEditor, 'web/unrelated.js', 'unrelated = 1\n', 'feat(web): unrelated [G1]').status, 0);
  box.git(box.repo, 'merge', '-q', '--no-ff', box.git(mainEditor, 'rev-parse', 'HEAD'), '-m', 'chore(merge): unrelated main change [G1]');
  syncTrunk();
  assert.ok(items().every(item => !item.item_verdict_state), 'unrelated main files do not stale acceptance');
  assert.equal((await http('/state')).state.items[0].verdictState, undefined);
  const beforeMoveHead = box.git(reviewer, 'rev-parse', 'HEAD');
  streamController = new AbortController();
  const stream = await fetchFresh(address.origin + apiPath + '/events?after=' + initialState.sequence, {
    headers: { ...headers, accept: 'text/event-stream' }, signal: streamController.signal,
  });
  assert.equal(stream.status, 200);
  streamReader = stream.body.getReader();
  box.git(mainEditor, 'merge', '-q', '--ff-only', 'main');
  assert.equal(helpers.commitFile(box, mainEditor, 'web/feature.js', 'feature = 0\nmain = 1\n', 'feat(web): change main caller [G1]').status, 0);
  box.git(box.repo, 'merge', '-q', '--no-ff', box.git(mainEditor, 'rev-parse', 'HEAD'), '-m', 'chore(merge): change main caller [G1]');
  const movingCommit = box.git(box.repo, 'rev-parse', 'HEAD');
  syncTrunk();
  for (const item of items()) {
    assert.equal(item.item_verdict_state?.code, 'STALE_VERDICT');
    assert.equal(item.item_verdict_state.file, 'web/feature.js');
    assert.equal(item.item_verdict_state.commit, movingCommit);
    assert.equal(item.item_verdict, 'ACCEPT', 'the historical acceptance remains a fact');
  }
  assert.equal(box.git(reviewer, 'rev-parse', 'HEAD'), beforeMoveHead, 'the served worktree HEAD stayed fixed while main moved');
  const apiStale = (await http('/state')).state;
  assert.equal(apiStale.sequence, initialState.sequence, 'Git movement needs no board event to invalidate the state cache');
  assert.equal(apiStale.items[0].verdictState?.code, 'STALE_VERDICT');
  assert.equal(apiStale.items[0].verdictState.commit, movingCommit);
  const coldGit = [];
  const originalSpawn = childProcess.spawnSync;
  let phoneStale;
  try {
    childProcess.spawnSync = function (...args) {
      if (args[0] === 'git') coldGit.push(args[1]);
      return Reflect.apply(originalSpawn, this, args);
    };
    syncBuiltinESMExports();
    phoneStale = relaySnapshot(reviewer);
  } finally { childProcess.spawnSync = originalSpawn; syncBuiltinESMExports(); }
  assert.ok(coldGit.filter(args => args.includes('diff')).length <= 1,
    'unrelated main history must not start one file-diff process per commit: ' + JSON.stringify(coldGit));
  const phoneState = snapshotState(phoneStale, withBoard(box.repo, store.boardId));
  assert.equal(phoneState.items[0].verdictState?.commit, movingCommit, 'the sealed phone snapshot carries the same stale verdict at fixed served HEAD');
  assert.notEqual(presentationDigest(phoneBefore.presentation), presentationDigest(phoneStale.presentation), 'Git-only freshness changes cause a new sealed presentation');

  assert.equal((await http('/items/1')).item.verdictState?.commit, movingCommit);
  const streamDeadline = setTimeout(() => streamController.abort(new Error('trunk movement produced no live changed event')), 5_000); // budget: hang ceiling for a fixture-local change notification; no throughput claim.
  try {
    let buffered = '';
    while (!/event: changed\n/u.test(buffered)) {
      const { value, done } = await streamReader.read();
      assert.equal(done, false, 'the live stream stays open through the trunk change');
      buffered += new TextDecoder().decode(value);
    }
  } finally { clearTimeout(streamDeadline); }
  streamController.abort();
  await streamReader.cancel().catch(() => {});
  for (const root of [box.repo, peer]) {
    assert.match(run(box, root, 'show', '1'), /STALE_VERDICT/u);
    assert.equal(JSON.parse(run(box, root, 'list', '--all', '--json')).items[0].item_verdict_state?.commit, movingCommit);
    const resume = JSON.parse(run(box, root, 'resume', '--diagnostics', '--json'));
    assert.equal(resume.all[0].item_verdict_state?.commit, movingCommit);
    assert.deepEqual(resume.toMerge, [], 'resume never suggests landing a stale acceptance');
    assert.equal(resume.staleVerdicts[0].item_id, 1);
    assert.deepEqual(withBoard(root, board => store.verdictsFor(board, 1)), original, 'read projection cannot rewrite original proof');
    const refused = box.run(root, 'land', '--dry-run', '--json');
    assert.equal(refused.code, 1, refused.out + refused.err);
    const error = JSON.parse(refused.out).error;
    assert.equal(error.code, 'STALE_VERDICT');
    assert.ok(error.message.includes('web/feature.js') && error.message.includes(movingCommit), error.message);
  }
  box.git(box.repo, 'revert', '-m', '1', '--no-edit', movingCommit);
  syncTrunk();
  assert.ok(items().every(item => item.item_verdict_state?.commit === movingCommit), 'a revert cannot turn an old review into a new review');
  const priorChecks = readFileSync(checkedHeads, 'utf8');
  const oldHead = box.run(reviewer, 'verify', '1', 'accept', '--note', 'Trying the old candidate is insufficient.');
  assert.equal(oldHead.code, 1);
  assert.equal(readFileSync(checkedHeads, 'utf8'), priorChecks, 'old candidate is refused before running its check');
  box.git(reviewer, 'merge', '-q', '--no-edit', 'main');
  const composed = box.git(reviewer, 'rev-parse', 'HEAD');
  assert.notEqual(composed, submitted);
  const { holder, observed } = await holdForReviewQueue(box);
  let landingGuidance;
  try {
    landingGuidance = run(box, reviewer, 'verify', '1', 'accept', '--note', 'Re-reviewed the feature with the latest main caller and its reverted history.');
    assert.ok(existsSync(observed), 'the same prior reviewer really waited behind occupied fixture gate capacity');
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGTERM');
    const result = await holder.closed;
    assert.equal(result.code, 0, holder.failure ?? holder.stderrText);
  }
  assert.ok(landingGuidance.includes('git merge --no-ff ' + composed), 'the new-main manual landing hint names the checked composition, not the original submission');
  assert.equal(readFileSync(checkedHeads, 'utf8').trim().split('\n').at(-1), composed, 'the frozen check ran on the reviewed composition');
  const reviewed = withBoard(box.repo, board => store.verdictsFor(board, 1));
  assert.deepEqual(reviewed.slice(0, original.length), original);
  assert.equal(reviewed.length, original.length + 1, 're-review appends independent proof');
  const verdict = reviewed.at(-1);
  const outcome = withBoard(peer, board => {
    const move = prepareEngineMove(board, 'verify', [1, {
      agentId: verdict.verdict_by, decision: 'ACCEPT', note: verdict.verdict_note,
      head: verdict.verdict_head, digest: verdict.verdict_digest, policy: 'any',
      check: verdict.check, review: verdict.review, environment: verdict.environment,
    }]);
    return applyEngineMove(board, move, { sequence: 1, at: verdict.verdict_at });
  });
  assert.equal(outcome.error, undefined, JSON.stringify(outcome));
  const reviewPin = `refs/pullboard/items/1/${composed.slice(0, 12)}`;
  assert.equal(box.git(box.repo, 'rev-parse', reviewPin), composed, 'the checked commit is pinned durably for other replicas to fetch');
  assert.equal(items()[1].item_verdict_state?.code, 'STALE_VERDICT', 'a replica without the checked Git objects fails closed');
  const peerBoardId = withBoard(peer, store.boardId);
  assert.equal(snapshotState(relaySnapshot(peer), peerBoardId).items[0].verdictState?.code, 'STALE_VERDICT',
    'a sealed phone presentation also fails closed until the reviewed objects arrive');
  const peerApi = await serveApi({ runCommand: main, projects: () => [{ root: peer, name: 'Peer verdict fixture' }] });
  t.after(() => peerApi.close());
  const peerAddress = new URL(peerApi.url);
  /** Keep this peer's server alive across an object-only fetch without a board write. */
  const peerHttp = async suffix => {
    const response = await fetchFresh(peerAddress.origin + apiPath + suffix,
      { headers: { 'x-pullboard-key': peerAddress.searchParams.get('k') } });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await peerHttp('/state')).state.items[0].verdictState?.code, 'STALE_VERDICT');
  assert.equal((await peerHttp('/items/1')).item.verdictState?.code, 'STALE_VERDICT');
  box.git(peer, 'fetch', '-q', 'origin', reviewPin);
  assert.equal((await peerHttp('/items/1')).item.verdictState, undefined,
    'an object-only fetch clears a cached unavailable HTTP detail');
  assert.equal((await peerHttp('/state')).state.items[0].verdictState, undefined,
    'an object-only fetch clears a cached unavailable HTTP state');
  assert.equal(snapshotState(relaySnapshot(peer), peerBoardId).items[0].verdictState, undefined,
    'fetching the exact reviewed objects clears the sealed phone presentation without another board event or main move');
  assert.ok(items().every(item => !item.item_verdict_state), 'the same sealed re-review clears both replicas');
  assert.equal((await http('/state')).state.items[0].verdictState, undefined, 'a newer acceptance invalidates stale cached state');
  assert.equal((await http('/items/1')).item.verdictState, undefined);
  assert.equal(snapshotState(relaySnapshot(reviewer), withBoard(box.repo, store.boardId)).items[0].verdictState, undefined, 'the sealed phone presentation clears after the checked re-review');
  assert.deepEqual(withBoard(peer, board => store.verdictsFor(board, 1)), reviewed);
  box.git(box.repo, 'merge', '-q', '--no-edit', composed);
  syncTrunk();
  const landed = box.git(box.repo, 'rev-parse', 'HEAD');
  for (const root of [box.repo, peer]) withBoard(root, board => store.merged(board, 1, { agentId: 'coordinator', commit: landed }));
  assert.equal(helpers.commitFile(box, box.repo, 'web/feature.js', 'feature = 1\nmain = 2\n', 'feat(web): after landing [G1]').status, 0);
  syncTrunk();
  assert.ok(items().every(item => !item.item_verdict_state), 'landed items are not waiting for re-review');
  assert.ok(existsSync(join(peer, '.git', 'pullboard', 'board.sqlite')));
});


test('a checkout or trunk moving during verification cannot acquire proof [E8]', () => {
  const box = helpers.project();
  const reviewer = join(box.dir, 'moving-reviewer');
  const moveHead = join(box.dir, 'move-review-head');
  const moveMain = join(box.dir, 'move-review-main');
  const baseline = box.git(box.repo, 'rev-parse', 'main');
  const check = `grep -q '^feature = 1$' web/feature.js && if test -f '${moveHead}'; then git -C '${reviewer}' checkout -q --detach '${baseline}'; fi && if test -f '${moveMain}'; then git -C '${box.repo}' commit -q --allow-empty -m 'chore: move review trunk [G1]'; fi`;
  run(box, box.repo, 'add', 'web', 'Moving review', '--specs', 'G1', '--check', check, '--wait');
  run(box, box.web, 'claim', '1');
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.js', 'feature = 1\n', 'feat(web): moving review feature [G1]').status, 0);
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  run(box, box.web, 'submit', '1');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
  run(box, reviewer, 'join', 'web');
  writeFileSync(moveHead, 'armed');
  const moved = box.run(reviewer, 'verify', '1', 'accept', '--note', 'The check moved the live reviewer checkout.');
  assert.equal(moved.code, 1, moved.out + moved.err);
  assert.match(moved.err, /NOT_AT_COMMIT/u);
  assert.equal(box.git(reviewer, 'rev-parse', 'HEAD'), baseline, 'the actual checkout moved while its private check was running');
  assert.deepEqual(withBoard(box.repo, board => store.verdictsFor(board, 1)), []);
  rmSync(moveHead);
  box.git(reviewer, 'checkout', '-q', '--detach', submitted);
  writeFileSync(moveMain, 'armed');
  const mainMoved = box.run(reviewer, 'verify', '1', 'accept', '--note', 'The check moved the known main.');
  assert.equal(mainMoved.code, 1, mainMoved.out + mainMoved.err);
  assert.match(mainMoved.err, /VERDICT_TRUNK_MOVED/u);
  assert.notEqual(box.git(box.repo, 'rev-parse', 'main'), baseline);
  assert.deepEqual(withBoard(box.repo, board => store.verdictsFor(board, 1)), []);
  rmSync(moveMain);
  run(box, reviewer, 'verify', '1', 'accept', '--note', 'The candidate and known trunk stayed fixed through the complete frozen check.');
  assert.equal(withBoard(box.repo, board => store.verdictsFor(board, 1)).length, 1);
});


test('landing retains the exact repair that passed stale re-review [E8,V8,R3]', () => {
  const box = helpers.project();
  const source = (feature, expected) => `feature = ${feature}\n${'// independent caller line\n'.repeat(12)}expected = ${expected}\n`;
  assert.equal(helpers.commitFile(box, box.repo, 'web/feature.txt', source(0, 1), 'feat(web): baseline caller [G1]').status, 0);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const check = `test "$(sed -n 's/^feature = //p' web/feature.txt)" = "$(sed -n 's/^expected = //p' web/feature.txt)"`;
  run(box, box.repo, 'add', 'web', 'Repair follows its review', '--specs', 'G1', '--check', check, '--wait');
  run(box, box.web, 'claim', '1');
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.txt', source(1, 1), 'feat(web): original feature [G1]').status, 0);
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  run(box, box.web, 'submit', '1');
  const reviewer = join(box.dir, 'repair-reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
  run(box, reviewer, 'join', 'web');
  run(box, reviewer, 'verify', '1', 'accept', '--note', 'The original feature matches the original caller.');
  const original = withBoard(box.repo, board => store.verdictsFor(board, 1));
  assert.equal(helpers.commitFile(box, box.repo, 'web/feature.txt', source(0, 2), 'feat(web): caller now requires two [G1]').status, 0);
  assert.equal(JSON.parse(run(box, box.repo, 'show', '1', '--json')).item_verdict_state?.code, 'STALE_VERDICT');
  box.git(reviewer, 'merge', '-q', '--no-edit', 'main');
  assert.equal(helpers.commitFile(box, reviewer, 'web/feature.txt', source(2, 2), 'feat(web): repair against the new caller [G1]').status, 0);
  assert.equal(helpers.commitFile(box, reviewer, 'web/repair.txt', 'ready\n', 'feat(web): add the repair companion [G1]').status, 0);
  const checked = box.git(reviewer, 'rev-parse', 'HEAD');
  run(box, reviewer, 'verify', '1', 'accept', '--note', 'The repaired composition matches the new caller; the original feature does not.');
  const reviewed = withBoard(box.repo, board => store.verdictsFor(board, 1));
  assert.deepEqual(reviewed.slice(0, original.length), original);
  assert.equal(reviewed.at(-1).verdict_head, checked);
  const probe = join(box.dir, 'repair-path-replica');
  box.git(box.dir, 'clone', '-q', box.repo, probe);
  withBoard(probe, board => importBoard(board, withBoard(box.repo, exportBoard)));
  box.git(probe, 'fetch', '-q', 'origin', `refs/pullboard/items/1/${checked.slice(0, 12)}`);
  assert.equal(helpers.commitFile(box, probe, 'web/repair.txt', 'main changed the repair\n', 'feat(web): main changes a repair file [G1]').status, 0);
  const changedRepair = JSON.parse(run(box, probe, 'show', '1', '--json'));
  assert.equal(changedRepair.item_verdict_state?.file, 'web/repair.txt', 'a file introduced by the checked repair must participate in later freshness');

  const remote = join(box.dir, 'landing-remote.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  const landed = JSON.parse(run(box, box.repo, 'land', '--json'));
  assert.deepEqual(landed.landed, [1], JSON.stringify(landed));
  assert.equal(box.git(box.repo, 'show', landed.batch.tip + ':web/feature.txt'), source(2, 2).trim(), 'landing must retain the exact repaired file that passed the frozen check');
  assert.equal(box.git(box.remote ?? remote, 'rev-parse', 'main'), landed.batch.tip);
  assert.equal(withBoard(box.repo, board => store.getItem(board, 1)).item_commit, submitted, 'the original submission remains the immutable item identity');
});

test('an older pushed landing shows stale checked proof and a correction path across public views [E8,H16,R3]',
  { timeout: 120_000 }, async t => { // budget: hang ceiling for real Git, private push and CLI verification; not a speed target.
    const box = helpers.project();
    assert.equal(helpers.commitFile(box, box.repo, 'web/feature.txt', 'feature = 0\n', 'feat(web): legacy landing base [G1]').status, 0);
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    const base = box.git(box.repo, 'rev-parse', 'HEAD');
    run(box, box.repo, 'add', 'web', 'Legacy landing review', '--specs', 'G1', '--check', 'test -f web/feature.txt', '--wait');
    run(box, box.web, 'claim', '1');
    assert.equal(helpers.commitFile(box, box.web, 'web/feature.txt', 'feature = 1\n', 'feat(web): legacy pushed feature [G1]').status, 0);
    const submitted = box.git(box.web, 'rev-parse', 'HEAD');
    run(box, box.web, 'submit', '1');
    const reviewer = join(box.dir, 'legacy-landing-reviewer');
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
    run(box, reviewer, 'join', 'web');
    run(box, reviewer, 'verify', '1', 'accept', '--note', 'The original submitted feature passed.');
    const remote = join(box.dir, 'legacy-landing-remote.git');
    box.git(box.dir, 'init', '-q', '--bare', remote);
    box.git(box.repo, 'remote', 'add', 'origin', remote);
    box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
    // The older coordinator pushed B; this replica's retained main still has A.
    box.git(box.web, 'push', '-q', 'origin', `${submitted}:refs/heads/main`);
    const entry = { id: 1, commit: submitted, merge: submitted };
    const batch = { version: 1, id: 'real-legacy-push', state: 'pushed', base, tip: submitted,
      branch: 'refs/heads/main', root: box.repo, owner: 'fixture', logPath: join(box.dir, 'landing.log'),
      candidates: [entry], items: [entry], revision: 0 };
    withBoard(box.repo, board => store.recordLandingBatch(board, { agentId: 'coordinator', batch }));
    const archived = join(box.dir, 'engine12');
    mkdirSync(archived);
    unpackRelease('59a6e2b286ee852add0d68a659f1a1e6b3257c44', archived);
    const oldStore = await import(pathToFileURL(join(archived, 'src/board.js')).href);
    const oldExchange = await import(pathToFileURL(join(archived, 'src/exchange.js')).href);
    const oldEngine = await import(pathToFileURL(join(archived, 'src/engine.js')).href);
    const old = oldStore.openBoard(join(box.dir, 'old.sqlite'));
    t.after(() => oldStore.closeBoard(old));
    oldExchange.importBoard(old, withBoard(box.repo, exportBoard));
    const finish = oldEngine.prepareEngineMove(old, 'finishLandingBatch', [{ agentId: 'coordinator', id: batch.id, tip: submitted }], { id: 'actual-legacy-in-flight-finish' });
    assert.equal(finish.engine, 12);

    assert.equal(helpers.commitFile(box, box.repo, 'web/feature.txt', 'feature = 2\n', 'feat(web): newer main requirement [G1]').status, 0);
    const conflict = box.tryGit(reviewer, 'merge', '-q', '--no-edit', 'main');
    assert.notEqual(conflict.status, 0, 'the older feature conflicts with this replica\'s newer requirement');
    assert.match(`${conflict.stdout ?? ''}${conflict.stderr ?? ''}`, /CONFLICT \(content\)/u);
    assert.equal(helpers.commitFile(box, reviewer, 'web/feature.txt', 'feature = 3\n', 'fix(web): checked correction composition [G1]').status, 0);
    const checked = box.git(reviewer, 'rev-parse', 'HEAD');
    run(box, reviewer, 'verify', '1', 'accept', '--note', 'The newer checked composition passed its frozen check.');
    const verdicts = withBoard(box.repo, board => store.verdictsFor(board, 1));
    const outcome = withBoard(box.repo, board => applyEngineMove(board, finish, { sequence: 1, at: '2026-10-17T20:00:00.000Z' }));
    assert.equal(outcome.error, undefined, JSON.stringify(outcome));
    assert.equal(box.git(remote, 'rev-parse', 'main'), submitted, 'the immutable receipt names the actual earlier private push');
    assert.equal(box.tryGit(box.repo, 'merge-base', '--is-ancestor', checked, 'main').status, 1, 'the newer checked composition has not landed');
    const item = JSON.parse(run(box, box.repo, 'show', '1', '--json'));
    assert.equal(item.item_merged_commit, submitted);
    assert.equal(item.item_verdict_state?.code, 'STALE_VERDICT');
    assert.equal(item.item_verdict_state?.landingCode, 'LAND_ITEM_MOVED');
    assert.equal(item.item_verdict_state?.checked, checked);
    const explanation = run(box, box.repo, 'show', '1');
    assert.match(explanation, /create a correction item/u);
    assert.match(explanation, new RegExp(checked));
    assert.doesNotMatch(explanation, /then another agent runs pullboard verify 1 accept/u);
    assert.deepEqual(withBoard(box.repo, board => store.verdictsFor(board, 1)), verdicts, 'presentation does not rewrite proof');
    const api = await serveApi({ runCommand: main, projects: () => [{ root: box.repo, name: 'Older landing fixture' }] });
    t.after(() => api.close());
    const address = new URL(api.url);
    const detail = await fetchFresh(address.origin + '/api/v1/boards/' + withBoard(box.repo, store.boardId) + '/items/1',
      { headers: { 'x-pullboard-key': address.searchParams.get('k') } });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).item.verdictState?.landingCode, 'LAND_ITEM_MOVED');
    assert.equal(snapshotState(relaySnapshot(box.repo), withBoard(box.repo, store.boardId)).items[0].verdictState?.landingCode, 'LAND_ITEM_MOVED');
    const missing = join(box.dir, 'legacy-landing-missing-objects');
    box.git(box.dir, 'clone', '-q', '--no-local', box.repo, missing);
    assert.notEqual(box.tryGit(missing, 'cat-file', '-e', checked).status, 0, 'this independent clone has not fetched the checked composition');
    withBoard(missing, board => importBoard(board, withBoard(box.repo, exportBoard)));
    const unavailable = JSON.parse(run(box, missing, 'show', '1', '--json'));
    assert.equal(unavailable.item_verdict_state?.landingCode, 'LAND_ITEM_MOVED');
    assert.equal(unavailable.item_verdict_state?.checked, checked);
    assert.match(run(box, missing, 'show', '1'), /create a correction item/u,
      'missing reviewed objects must never suggest re-reviewing an immutable landing');
    const refused = box.run(reviewer, 'verify', '1', 'accept', '--note', 'Cannot rewrite the original landing.');
    assert.equal(refused.code, 1);
    assert.match(refused.err, /NOT_SUBMITTED|ALREADY_MERGED/u, 'the existing merged-receipt guards stay in force');
    box.git(box.repo, 'merge', '-q', '--no-edit', checked);
    assert.equal(JSON.parse(run(box, box.repo, 'show', '1', '--json')).item_verdict_state, undefined,
      'a later correction containing the checked composition clears the derived warning without rewriting the old landing');
    assert.equal(withBoard(box.repo, board => store.getItem(board, 1)).item_merged_commit, submitted);
  });

/** A person's own session, through the stand-in GitHub's real OAuth, signed in as `login`. */
async function personSession(box, login) {
  box.providerState.signer = login;
  try {
    const start = await fetch(box.origin + '/auth/github/start', { redirect: 'manual' });
    const binding = start.headers.getSetCookie().find((value) => value.startsWith('pb_oauth_binding=')).split(';')[0];
    const approved = await fetch(start.headers.get('location'), { redirect: 'manual' });
    const callback = await fetch(approved.headers.get('location'), { redirect: 'manual', headers: { cookie: binding } });
    assert.equal(callback.status, 303, `${login} signs in`);
    return callback.headers.getSetCookie().find((value) => value.startsWith('pb_session=')).split(';')[0].slice('pb_session='.length);
  } finally { box.providerState.signer = 'alice'; }
}

/** Call the relay as one credential, returning the status and document. */
async function relayCall(box, token, method, path, body) {
  const response = await fetch(box.origin + path, { method, headers: { authorization: 'Bearer ' + token, 'x-pullboard-engine': String(PEOPLE_VERSION),
    ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let document = null;
  try { document = await response.json(); } catch { /* An empty answer stays null. */ }
  return { status: response.status, document };
}

/** Seal one phone request the way the paired view does and send it with this person's session. */
async function phoneRequest(box, session, move) {
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const head = await relayCall(box, session, 'GET', '/api/v2/boards/' + link.board + '/state');
  assert.equal(head.status, 200, `this person reads the board: ${JSON.stringify(head.document)}`);
  const events = await relayCall(box, session, 'GET', `/api/v1/boards/${link.board}/events?after=${head.document.state.sequence}`);
  const sequence = Math.max(head.document.state.sequence, ...(events.document.events ?? []).map((event) => event.event_id)) + 1;
  const document = { version: 1, type: 'person-request', id: randomUUID(), move };
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const sealed = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(document)), { boardId: link.board, kind: 'request', sequence })).toString('base64url');
  const sent = await relayCall(box, session, 'POST', `/api/v1/boards/${link.board}/requests`, { sequence, sealed });
  assert.equal(sent.status, 200, `the relay stores the sealed request: ${JSON.stringify(sent.document)}`);
  return document.id;
}

/** The phone requests this board has received, by id. */
async function receivedRequests(box) {
  assert.equal((await box.cli('status')).code, 0, 'the coordinator reads the relay');
  const meta = (await box.cli('export')).document.tables.board_meta.find((row) => row.meta_key === 'relay_person_requests');
  return Object.fromEntries((meta ? JSON.parse(meta.meta_value) : []).map((record) => [record.id, record]));
}

/** Two people with write access to the fixture repository, alice and bob, and alice's linked board. */
async function teamBoard(t, approvers) {
  const box = await relayClientFixture(t);
  Object.assign(box.providerState, { people: { alice: { id: 7, permission: 'write' }, bob: { id: 8, permission: 'write' } }, signer: 'alice' });
  if (approvers) {
    const file = join(box.root, 'pullboard.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), approvers }, null, 2) + '\n');
    runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
    runFixtureGit(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'chore: name the approvers'], { cwd: box.root, env: box.env });
  }
  assert.equal((await box.link()).code, 0, 'alice links the board, signed in as herself');
  return box;
}

test('the board knows its people: events name them, approvers decide [E3,E4,E20]', { timeout: 180_000 }, async (t) => { // budget: hang ceiling for two people's real CLI runs and relay calls; not a speed target.
  const box = await teamBoard(t, ['alice']);
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const alice = await personSession(box, 'alice');
  const bob = await personSession(box, 'bob');
  assert.deepEqual((await relayCall(box, alice, 'GET', `/api/v1/boards/${link.board}/approvers`)).document.approvers, ['alice'], 'relay on gave the relay the approvers pullboard.json names');

  // S4c: every move records the person who made it, and the agent if one did.
  assert.equal((await box.cli('add', box.lane, 'An item alice adds')).code, 0);
  const bobRoot = join(box.root, '..', 'bob-clone');
  runFixtureGit(['clone', '-q', box.root, bobRoot], { cwd: box.root, env: box.env });
  runFixtureGit(['remote', 'set-url', 'origin', 'git@github.com:fixture/repository.git'], { cwd: bobRoot, env: box.env });
  const bobHome = join(box.root, '..', 'bob-home');
  const bobEnv = { ...box.env, HOME: bobHome, PULLBOARD_HOME: join(bobHome, '.pullboard'), PULLBOARD_MACHINE_HOME: join(bobHome, 'machine') };
  cpSync(join(box.root, '.git', 'pullboard'), join(bobRoot, '.git', 'pullboard'), { recursive: true, filter: (path) => !path.endsWith('.lock') });
  mkdirSync(join(bobEnv.PULLBOARD_HOME, 'relay-keys'), { recursive: true, mode: 0o700 });
  cpSync(box.keyFile, join(bobEnv.PULLBOARD_HOME, 'relay-keys', link.board + '.key'));
  box.providerState.signer = 'bob';
  const bobOn = await relayFixtureChild(bobRoot, bobEnv, [CLI, 'relay', 'on', '--url', box.origin, '--json']);
  box.providerState.signer = 'alice';
  assert.equal(bobOn.code, 0, `bob signs in as himself on his own computer: ${bobOn.stderr}`);
  // One coordinator per board [E19]: bob's main checkout takes the coordinator to act, then alice takes it back.
  const bobTakes = await relayFixtureChild(bobRoot, bobEnv, [CLI, 'takeover', '--json']);
  assert.equal(bobTakes.code, 0, `bob's main checkout takes the coordinator: ${JSON.stringify(bobTakes.document?.error ?? null)}`);
  const bobAdd = await relayFixtureChild(bobRoot, bobEnv, [CLI, 'add', box.lane, 'An item bob adds', '--json']);
  assert.equal(bobAdd.code, 0, `bob adds an item: ${JSON.stringify(bobAdd.document?.error ?? null)}`);
  assert.equal((await box.cli('takeover')).code, 0, 'alice’s main checkout takes the coordinator back');
  const exported = (await box.cli('export')).document.tables;
  const events = exported.event;
  const madeBy = (title) => {
    const id = exported.item.find((item) => item.item_title === title)?.item_id;
    return events.filter((event) => event.event_kind === 'add' && event.item_id === id).map((event) => JSON.parse(event.event_detail).person);
  };
  assert.deepEqual(madeBy('An item alice adds'), ['alice'], 'alice’s move names alice');
  assert.deepEqual(madeBy('An item bob adds'), ['bob'], 'bob’s move names bob');
  assert.ok(events.filter((event) => event.event_kind === 'add').every((event) => event.event_by), 'each move still names the agent or seat that made it');

  // S4b: only an approver answers the person's decisions, and only an approver decides rows.
  const asked = await box.cli('shout', 'person', 'Ship the health endpoint as plain text or JSON?', '--decision');
  assert.equal(asked.code, 0);
  const decision = asked.document.id ?? asked.document.shout_id ?? asked.document.result?.id;
  const fromBob = await phoneRequest(box, bob, { verb: 'answer', item: Number(decision), args: { text: 'JSON' } });
  const fromAlice = await phoneRequest(box, alice, { verb: 'answer', item: Number(decision), args: { text: 'JSON' } });
  const requests = await receivedRequests(box);
  assert.equal(requests[fromBob].status, 'refused', 'bob, a writer but not an approver, cannot answer as the person');
  assert.equal(requests[fromBob].error.code, 'NOT_APPROVER');
  assert.notEqual(requests[fromAlice].status, 'refused', 'alice, an approver, answers as the person');
  const rowFromBob = await phoneRequest(box, bob, { verb: 'spec-approve', args: { ids: 'G1' } });
  assert.equal((await receivedRequests(box))[rowFromBob].error?.code, 'NOT_APPROVER', 'bob cannot approve a row');

  // E4: a change to the list takes effect only once an existing approver makes it.
  assert.equal((await relayCall(box, bob, 'PUT', `/api/v1/boards/${link.board}/approvers`, { approvers: ['bob'] })).document.error?.code, 'NOT_APPROVER', 'bob cannot make himself an approver');
  assert.deepEqual((await relayCall(box, bob, 'GET', `/api/v1/boards/${link.board}/approvers`)).document.approvers, ['alice']);

  // S9: a move no member can open is set aside, and only an approver unlinks the board or replaces its snapshot.
  const bobMachine = JSON.parse(readFileSync(join(bobRoot, '.git', 'pullboard', 'relay.json'), 'utf8')).token;
  const head = await relayCall(box, alice, 'GET', '/api/v2/boards/' + link.board + '/state');
  const after = await relayCall(box, alice, 'GET', `/api/v1/boards/${link.board}/events?after=${head.document.state.sequence}`);
  const next = Math.max(head.document.state.sequence, ...(after.document.events ?? []).map((event) => event.event_id)) + 1;
  const junk = await relayCall(box, bobMachine, 'POST', `/api/v1/boards/${link.board}/moves`, { sequence: next, sealed: randomBytes(64).toString('base64url') });
  assert.equal(junk.status, 200, 'a member’s credential can store bytes no key opens');
  const afterJunk = await box.cli('add', box.lane, 'After the junk');
  assert.equal(afterJunk.code, 0, `replay sets the unopenable move aside and the board moves on: ${afterJunk.stderr ?? ''}${JSON.stringify(afterJunk.document ?? {}).slice(0, 600)}`);
  assert.ok((await box.cli('export')).document.tables.event.some((event) => event.event_kind === 'relay_refused' && JSON.parse(event.event_detail).sequence === next), 'the set-aside move is on the record');
  const deleted = await relayCall(box, bob, 'DELETE', `/api/v1/boards/${link.board}`);
  assert.equal(deleted.document?.error?.code, 'NOT_APPROVER', 'bob cannot unlink the board');
  const replaced = await relayCall(box, bobMachine, 'PUT', `/api/v1/boards/${link.board}/state`, { sequence: next, sealed: randomBytes(64).toString('base64url') });
  assert.equal(replaced.document?.error?.code, 'NOT_APPROVER', 'bob’s computer cannot replace the snapshot');
  assert.equal((await box.cli('status')).code, 0, 'alice’s board still reads');
});

test('the board knows its people: a phone move names the phone’s person, refused or not [E3,E4]', { timeout: 180_000 }, async (t) => { // budget: hang ceiling for real CLI runs and relay calls; not a speed target.
  const box = await teamBoard(t, ['alice']);
  const bob = await personSession(box, 'bob');
  // Bob's phone adds an item; alice's computer carries it out, so the move is sent with alice's credential.
  const title = 'An item from bob’s phone';
  const added = await phoneRequest(box, bob, { verb: 'add', args: { lane: box.lane, title } });
  const asked = await box.cli('shout', 'person', 'Plain text or JSON?', '--decision');
  assert.equal(asked.code, 0);
  const decision = asked.document.id ?? asked.document.shout_id ?? asked.document.result?.id;
  const denied = await phoneRequest(box, bob, { verb: 'answer', item: Number(decision), args: { text: 'JSON' } });
  const requests = await receivedRequests(box);
  assert.equal(requests[added].status, 'done', 'bob’s phone adds the item');
  assert.equal(requests[denied].error?.code, 'NOT_APPROVER', 'bob’s phone cannot answer as the person');
  const tables = (await box.cli('export')).document.tables;
  const id = tables.item.find((item) => item.item_title === title)?.item_id;
  const add = tables.event.find((event) => event.event_kind === 'add' && event.item_id === id);
  const refused = tables.event.find((event) => event.event_kind === 'relay_refused' && JSON.parse(event.event_detail).sequence === requests[denied].sequence);
  assert.ok(add && refused, 'both are on the record');
  assert.equal(JSON.parse(add.event_detail).person, 'bob', 'the add names bob, whose phone asked for it, not alice, whose computer carried it out');
  assert.equal(JSON.parse(refused.event_detail).person, 'bob', 'the refused answer still names bob, who tried it');
});

test('a board that names no approvers takes person moves as before [E4]', { timeout: 120_000 }, async (t) => { // budget: hang ceiling for real CLI runs and relay calls; not a speed target.
  const box = await teamBoard(t, null);
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const bob = await personSession(box, 'bob');
  assert.equal((await relayCall(box, bob, 'GET', `/api/v1/boards/${link.board}/approvers`)).document.approvers, null, 'the relay holds no approvers for this board');
  const asked = await box.cli('shout', 'person', 'Plain text or JSON?', '--decision');
  const decision = asked.document.id ?? asked.document.shout_id ?? asked.document.result?.id;
  const fromBob = await phoneRequest(box, bob, { verb: 'answer', item: Number(decision), args: { text: 'JSON' } });
  assert.notEqual((await receivedRequests(box))[fromBob].status, 'refused', 'any writer’s session answers as the person, as today');
});

/** Another computer of a person: its own HOME, ~/.ssh and a fresh clone of the fixture repository. */
function memberDevice(t, box, name) {
  const home = join(box.root, '..', name + '-home');
  const root = join(box.root, '..', name + '-clone');
  mkdirSync(join(home, '.ssh'), { recursive: true, mode: 0o700 });
  runFixtureGit(['clone', '-q', box.root, root], { cwd: box.root, env: box.env });
  runFixtureGit(['remote', 'set-url', 'origin', 'git@github.com:fixture/repository.git'], { cwd: root, env: box.env });
  const env = { ...box.env, HOME: home, PULLBOARD_HOME: join(home, '.pullboard'), PULLBOARD_MACHINE_HOME: join(home, 'machine') };
  delete env.PULLBOARD_MODEL;
  delete env.PULLBOARD_SSH_KEY; // A separate computer cannot inherit Alice’s private signing-key path.
  const device = { root, env, home, cli: (...args) => relayFixtureChild(root, env, [CLI, ...args, '--json']) };
  /** Generate this device's SSH key, as ssh-keygen -t ed25519 does, and return its public line. */
  device.sshKey = () => {
    const made = childProcess.spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', join(home, '.ssh', 'id_ed25519')], { env, encoding: 'utf8' });
    assert.equal(made.status, 0, `ssh-keygen makes the device's key: ${made.stderr}`);
    return readFileSync(join(home, '.ssh', 'id_ed25519.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
  };
  /** Start a command that waits, and resolve said(text) once its stderr carries text. */
  device.start = (...args) => {
    const child = childProcess.spawn(process.execPath, [CLI, ...args, '--json'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const waiting = [];
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; for (const waiter of [...waiting]) waiter(); });
    const closed = new Promise((resolve) => child.once('close', (code) => {
      let document;
      try { document = JSON.parse(stdout); } catch { document = null; }
      for (const waiter of [...waiting]) waiter();
      resolve({ code, stderr, document });
    }));
    t.after(() => child.kill('SIGKILL'));
    /** Resolve once stderr carries the text, or the command has closed. */
    const said = (text) => new Promise((resolve) => {
      const check = () => { if (stderr.includes(text) || child.exitCode !== null) { waiting.splice(waiting.indexOf(check), 1); resolve(stderr.includes(text)); } };
      waiting.push(check);
      check();
    });
    return { closed, said };
  };
  return device;
}

test('a clone of a linked repo joins its board; a member device hands over the key [E1,E12,E17]', { timeout: relayWorkBudgetMs(20) }, async (t) => { // budget: hang ceiling for four devices' real CLI runs, ssh-keygen and relay calls; not a speed target.
  const box = await teamBoard(t, ['alice']);
  // Each computer has OpenSSH's ssh-keygen, and reads SSH keys from the stand-in GitHub.
  const tools = join(box.root, '..', 'tools-bin');
  mkdirSync(tools, { mode: 0o700 });
  for (const name of readdirSync(box.env.PATH)) symlinkSync(join(box.env.PATH, name), join(tools, name));
  const sshKeygen = childProcess.spawnSync('sh', ['-c', 'command -v ssh-keygen'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(sshKeygen, 'the test machine has OpenSSH');
  symlinkSync(sshKeygen, join(tools, 'ssh-keygen'));
  Object.assign(box.env, { PATH: tools, PULLBOARD_GITHUB_API: box.providerOrigin });
  const aliceKey = join(box.root, '..', 'alice-handover-key');
  assert.equal(runFixtureChild('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', aliceKey], { encoding: 'utf8' }).status, 0);
  box.env.PULLBOARD_SSH_KEY = aliceKey;
  const alicePublic = readFileSync(aliceKey + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' ');
  box.providerState.sshKeys = { alice: [alicePublic] };
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const config = join(box.root, 'pullboard.json');
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).relay?.board, link.board, 'relay on writes the board’s id into pullboard.json');
  assert.equal((await box.cli('add', box.lane, 'Health endpoint')).code, 0);

  // S5: a clone made before pullboard.json named the board links no second board for the repository.
  const early = memberDevice(t, box, 'bob-early');
  assert.equal((await early.cli('init')).code, 0);
  assert.equal((await early.cli('add', box.lane, 'Health endpoint')).code, 0);
  box.providerState.signer = 'bob';
  const split = await early.cli('relay', 'on', '--url', box.origin);
  assert.equal(split.document?.error?.code, 'BOARD_REPO_LINKED', `the relay refuses a second board for the repository: ${JSON.stringify(split.document?.error ?? null)}`);
  assert.match(split.document.error.message + ' ' + split.document.error.next, new RegExp(link.board + '[\\s\\S]*pullboard.json'), 'the refusal names the board and where a clone finds it');
  assert.equal(box.auth.linkedBoards().length, 1, 'the relay holds one board for the repository');
  assert.equal(existsSync(join(early.root, '.git', 'pullboard', 'relay.json')), false, 'the refused clone keeps no half-made link');

  // Once pullboard.json names the board, that clone keeps its own work rather than hide it under the team board.
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  runFixtureGit(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'chore: name the relay board'], { cwd: box.root, env: box.env });
  rmSync(join(early.root, 'pullboard.json')); // the clone's own init wrote it before the repository carried one
  runFixtureGit(['pull', '-q', '--no-rebase', box.root, 'HEAD'], { cwd: early.root, env: early.env });
  const kept = await early.cli('relay', 'on', '--url', box.origin);
  assert.equal(kept.document?.error?.code, 'RELAY_JOIN_NOT_EMPTY', `a clone with work of its own is not joined over it: ${JSON.stringify(kept.document?.error ?? null)}`);
  assert.equal(box.auth.linkedBoards().length, 1);

  const members = await box.cli('relay', 'members', 'set', 'bob');
  assert.equal(members.code, 0, `alice publishes a real signed member list: ${members.stderr}`);
  assert.deepEqual(members.document.members, ['bob']);

  // E17: a device key signed by an SSH key that is not on bob's GitHub account gets no board key.
  box.providerState.sshKeys = { alice: [alicePublic], bob: [] };
  const stray = memberDevice(t, box, 'bob-stray');
  assert.equal((await stray.cli('init')).code, 0);
  stray.sshKey();
  const strayOn = stray.start('relay', 'on', '--url', box.origin);
  assert.equal(await strayOn.said('no member device is online'), true, 'with no member online the new device says so and waits');
  assert.equal((await box.cli('status')).code, 0, 'alice’s computer comes online');
  const refused = await strayOn.closed;
  assert.equal(refused.document?.error?.code, 'RELAY_KEY_VOUCH', `the member device refuses a key no GitHub SSH key vouches for: ${refused.stderr}`);
  assert.equal(existsSync(join(stray.env.PULLBOARD_HOME, 'relay-keys', link.board + '.key')), false, 'the stray device holds no board key');

  // E17: bob's new device, its key on his GitHub account, joins once a member device is online.
  const fresh = memberDevice(t, box, 'bob-new');
  assert.equal((await fresh.cli('init')).code, 0);
  box.providerState.sshKeys = { alice: [alicePublic], bob: [fresh.sshKey()] };
  const freshOn = fresh.start('relay', 'on', '--url', box.origin);
  assert.equal(await freshOn.said('no member device is online'), true, 'the new device says no member is online and waits');
  assert.equal((await box.cli('status')).code, 0, 'alice’s computer comes online and hands the key over');
  const joined = await freshOn.closed;
  box.providerState.signer = 'alice';
  assert.equal(joined.code, 0, `relay on in the clone joins the board: ${joined.stderr}; ${JSON.stringify(joined.document?.error ?? null)}`);
  assert.equal(JSON.parse(readFileSync(join(fresh.root, '.git', 'pullboard', 'relay.json'), 'utf8')).board, link.board, 'the clone works on the board pullboard.json names');
  assert.equal(box.auth.linkedBoards().length, 1, 'joining never links another board');
  const listed = await fresh.cli('list', '--all');
  assert.ok(listed.document.items.some((item) => (item.title ?? item.item_title) === 'Health endpoint'), 'the joined clone reads the team board');
  const bobLink = JSON.parse(readFileSync(join(fresh.root, '.git', 'pullboard', 'relay.json'), 'utf8'));
  assert.equal(bobLink.agentTokens?.coordinator, undefined, 'list membership does not create person coordinator authority');
  const coordinatorPath = withBoard(box.root, board => store.listAgents(board).find(agent => agent.agent_id === 'coordinator').agent_path);
  const bobWork = fresh.root + '-lane';
  runFixtureGit(['worktree', 'add', '--detach', bobWork, 'HEAD'], { cwd: fresh.root, env: fresh.env });
  const bobCli = (...args) => relayFixtureChild(bobWork, fresh.env, [CLI, ...args, '--json']);
  const bobJoined = await bobCli('join', box.lane, '--model', 'Fixture Model');
  assert.equal(bobJoined.code, 0, `the member registers an ordinary lane seat: ${JSON.stringify(bobJoined.document?.error ?? null)}`);
  const freshAdd = await bobCli('add', box.lane, 'From bob’s new computer');
  assert.equal(freshAdd.code, 0, `the joined clone moves on the team board: ${JSON.stringify(freshAdd.document?.error ?? null)}`);
  assert.ok((await box.cli('export')).document.tables.item.some((item) => item.item_title === 'From bob’s new computer'), 'one board, one order: alice reads bob’s move');
  assert.equal(withBoard(box.root, board => store.listAgents(board).find(agent => agent.agent_id === 'coordinator').agent_path), coordinatorPath, 'the ordinary member leaves Alice’s coordinator holder unchanged');
});

test('a relink turns the old link off with its receipt, so a repository keeps one active board [E12]', { timeout: 120_000 }, async (t) => { // budget: hang ceiling for real relay calls; not a speed target.
  const box = await teamBoard(t, null);
  const old = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
  const alice = await personSession(box, 'alice');
  const next = randomBytes(16).toString('hex');
  await assert.rejects(box.auth.linkBoard(alice, next, 'fixture/repository'), { code: 'BOARD_REPO_LINKED' }, 'a second board without replaces is refused');
  await assert.rejects(box.auth.linkBoard(alice, next, 'fixture/repository', Infinity, 'e'.repeat(32)), { code: 'BOARD_REPLACE' }, 'replaces must name the active board');
  const linked = await box.auth.linkBoard(alice, next, 'fixture/repository', Infinity, old);
  assert.equal(linked.replaced, old, 'the link reports the board it turned off');
  const receipt = box.auth.boardOff(old);
  assert.equal(receipt?.replacedBy, next, 'the old link is off, with a receipt naming its replacement');
  assert.equal(box.auth.boardOff(next), null, 'the new link is the active one');
  await assert.rejects(box.auth.linkBoard(alice, randomBytes(16).toString('hex'), 'fixture/repository', Infinity, old), { code: 'BOARD_REPLACE' },
    'an off board cannot be replaced again, so no caller can stack links');
  await assert.rejects(box.auth.linkBoard(alice, randomBytes(16).toString('hex'), 'fixture/repository'), { code: 'BOARD_REPO_LINKED' },
    'the replacement is the one active board');
});

/** Every file under a directory, so a test can prove no secret was written anywhere in it. */
function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)]);
}

test('every session reads and moves: terminal, SSH, agent, job or CI [E9,E18]', { timeout: 240_000 }, async (t) => { // budget: hang ceiling for real CLI runs on three homes and a loopback relay; not a speed target.
  const box = await sessionRelay(t);
  const cli = join(import.meta.dirname, '..', 'bin', 'pullboard.js');

  // S6d: on a machine with a keychain, relay on keeps the key in the owner-only file every session can read.
  const keychainBin = join(box.root, '..', 'keychain-bin');
  mkdirSync(keychainBin, { mode: 0o700 });
  for (const name of readdirSync(box.env.PATH)) symlinkSync(join(box.env.PATH, name), join(keychainBin, name));
  const keychainLog = join(box.root, '..', 'keychain-calls.log');
  for (const name of ['security', 'secret-tool']) {
    writeFileSync(join(keychainBin, name), `#!/bin/sh\necho "$1" >> ${JSON.stringify(keychainLog)}\n[ "$1" = search ] && exit 1\nexit 0\n`, { mode: 0o755 });
  }
  const plainPath = box.env.PATH;
  const inbox = await prepareKeylessInbox(box);
  box.env.PATH = keychainBin;
  assert.equal((await box.link()).code, 0, 'relay on links the board on a machine with a keychain');
  box.env.PATH = plainPath;
  const keys = join(box.env.PULLBOARD_HOME, 'relay-keys');
  assert.deepEqual(readdirSync(keys).filter((name) => name.endsWith('.key')).length, 1, 'the key sits in one owner-only file');
  assert.equal(statSyncMode(box.keyFile), 0o600, 'the key file is owner-only');
  const writes = existsSync(keychainLog) ? readFileSync(keychainLog, 'utf8').split('\n').filter((call) => ['add-generic-password', 'store'].includes(call)) : [];
  assert.deepEqual(writes, [], 'relay on never writes the key to the keychain');

  // S6b: a session that cannot read the key (SSH, a scheduled job, a locked keychain) still reads the whole board.
  assert.equal((await box.cli('add', box.lane, 'Read from any session')).code, 0);
  renameSync(keys, keys + '.parked');
  try {
    for (const command of [['list'], ['show', '1'], ['inbox'], ['whoami'], ['status'], ['resume'], ['log']]) {
      const read = command[0] === 'inbox' ? await readKeylessInbox(box, inbox) : await box.cli(...command);
      assert.equal(read.code, 0, `${command[0]} reads without the key: ${JSON.stringify(read.document?.error ?? null)}`);
    }
    const move = await box.cli('add', box.lane, 'Needs the key');
    assert.equal(move.document?.error?.code, 'RELAY_KEY_MISSING', 'a move without the key is refused, never sent or lost');
  } finally { renameSync(keys + '.parked', keys); }
  await finishKeylessInbox(box, inbox);

  // S6c: a CI or cloud session, with an agent token and the board key in its environment and no key file, reads and moves.
  // The project's committed setup is what every checkout, CI's included, gets.
  sessionGit(['add', '-A'], { cwd: box.root, env: box.env });
  sessionGit(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'chore: set up pullboard'], { cwd: box.root, env: box.env });
  const seatRoot = join(box.root, '..', 'ci-seat');
  sessionGit(['worktree', 'add', '-q', '-b', 'ci-seat', seatRoot], { cwd: box.root, env: box.env });
  const joined = await box.cliAt(seatRoot, 'join', box.lane, '--model', 'fixture-model');
  assert.equal(joined.code, 0, `the person gives CI its own seat: ${JSON.stringify(joined.document?.error ?? null)}`);
  const seat = (await box.cliAt(seatRoot, 'whoami')).document;
  assert.equal((await box.cliAt(seatRoot, 'shout', 'coordinator', 'the CI seat is ready')).code, 0, 'the seat moves once, which mints its token');
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const token = link.agentTokens?.[seat.id]?.token;
  assert.match(token ?? '', /^pa_/u, 'the seat holds its own agent token');
  const ciRoot = join(box.root, '..', 'ci-clone');
  sessionGit(['clone', '-q', box.root, ciRoot], { cwd: box.root, env: box.env });
  sessionGit(['remote', 'set-url', 'origin', 'git@github.com:fixture/repository.git'], { cwd: ciRoot, env: box.env });
  const ciHome = join(box.root, '..', 'ci-home');
  mkdirSync(ciHome, { mode: 0o700 });
  const key = readFileSync(box.keyFile, 'utf8').trim();
  // The CI machine also has a keychain holding a legacy copy of the key; the session must not move it into a file.
  const ciKeychainBin = join(ciHome, 'keychain-bin');
  mkdirSync(ciKeychainBin, { mode: 0o700 });
  for (const name of readdirSync(box.env.PATH)) symlinkSync(join(box.env.PATH, name), join(ciKeychainBin, name));
  for (const name of ['security', 'secret-tool']) {
    writeFileSync(join(ciKeychainBin, name), '#!/bin/sh\ncase "$1" in search) exit 1;; find-generic-password|lookup) printf %s "$PULLBOARD_RELAY_KEY"; exit 0;; esac\nexit 0\n', { mode: 0o755 });
  }
  const ciEnv = { ...box.env, HOME: ciHome, PULLBOARD_HOME: join(ciHome, '.pullboard'), PULLBOARD_MACHINE_HOME: join(ciHome, 'machine'), PATH: ciKeychainBin,
    PULLBOARD_RELAY_TOKEN: token, PULLBOARD_RELAY_KEY: key, PULLBOARD_RELAY_URL: box.origin };
  const ci = (...args) => sessionChild(ciRoot, ciEnv, [cli, ...args, '--json']);
  const status = await ci('status');
  assert.equal(status.code, 0, 'CI reads the board');
  const listed = await ci('list', '--all');
  assert.ok(listed.document.items.some((item) => (item.title ?? item.item_title) === 'Read from any session'),
    `CI reads the board’s items: ${JSON.stringify(listed.document.items?.map((item) => item.title ?? item.item_title))} ${JSON.stringify(status.document).replaceAll(token, '<token>').replaceAll(key, '<key>').slice(0, 900)}`);
  const added = await ci('add', box.lane, 'Added from CI');
  assert.equal(added.code, 0, `CI moves on the board: ${JSON.stringify(added.document?.error ?? null)}`);
  assert.equal((await box.cli('status')).code, 0);
  const items = (await box.cli('export')).document.tables.item;
  assert.ok(items.some((item) => item.item_title === 'Added from CI'), 'the CI move reaches the person’s board');
  assert.equal(filesUnder(join(ciEnv.PULLBOARD_HOME, 'relay-keys')).length, 0, 'CI keeps no key file');
  const written = [...filesUnder(join(ciRoot, '.git', 'pullboard')), ...filesUnder(ciHome)].map((file) => readFileSync(file)).map((bytes) => bytes.toString('latin1'));
  assert.equal(written.some((text) => text.includes(token) || text.includes(key)), false, 'neither the token nor the key is written to disk');
  for (const output of [status, listed, added]) {
    const shown = JSON.stringify(output.document) + (output.failure ?? '');
    assert.equal(shown.includes(token) || shown.includes(key), false, 'no output repeats a secret');
  }
  // A clone already linked to another board keeps its link: the environment never overwrites it.
  const otherLink = join(ciRoot, '.git', 'pullboard', 'relay.json');
  const elsewhere = JSON.stringify({ ...JSON.parse(readFileSync(otherLink, 'utf8')), board: 'f'.repeat(32) });
  writeFileSync(otherLink, elsewhere, { mode: 0o600 });
  const warned = await ci('status');
  assert.match(JSON.stringify(warned.document?.diagnostics ?? []), /RELAY_LINKED/u, 'the environment names the link to another board and the read goes on');
  const relayRead = await ci('relay', 'status');
  assert.equal(relayRead.code, 0, `relay status is a read too, so it goes on: ${JSON.stringify(relayRead.document?.error?.code ?? null)}`);
  assert.match(JSON.stringify(relayRead.document?.diagnostics ?? []), /RELAY_LINKED/u, 'relay status names the link to another board');
  const refused = await ci('add', box.lane, 'Added across boards');
  assert.notEqual(refused.code, 0, 'a session on another board’s link does not move');
  for (const output of [warned, relayRead, refused]) {
    const shown = JSON.stringify(output.document) + (output.failure ?? '');
    assert.equal(shown.includes(token) || shown.includes(key), false, 'the refusal repeats no secret');
  }
  assert.equal(readFileSync(otherLink, 'utf8'), elsewhere, 'the other board’s link is left as it was');
});

/** A file's permission bits. */
function statSyncMode(file) { return lstatSync(file).mode & 0o777; }

test('one coordinator per board across machines [E19]', { timeout: relayWorkBudgetMs(12) }, async t => { // budget: hang ceiling for two linked devices' real CLI and relay round trips; not a speed target.
  const box = await relayClientFixture(t);
  await box.link();
  const pairing = await box.cli('relay', 'pair');
  const other = await box.otherDeviceJoin(pairing.document.code);
  /** A refusal's code and message as the CLI reports them. */
  const refusal = result => ({ code: result.document?.error?.code, message: String(result.document?.error?.message ?? '') });

  // The first device to act as coordinator holds it; the board keeps working there as it does today.
  assert.equal((await box.cli('add', box.lane, 'Planned on the first machine')).code, 0, 'the first machine coordinates');
  assert.equal((await box.cli('add', box.lane, 'Still planned on the first machine')).code, 0, 'the holder keeps coordinating');

  // On one machine, the main checkout is held by one agent session at a time; takeover passes it between sessions.
  /** Run the first machine's real CLI from a named agent session. */
  const inSession = (session, ...args) => relayFixtureChild(box.root, { ...box.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session },
    [resolve(import.meta.dirname, '../bin/pullboard.js'), ...args, '--json']);
  assert.equal((await inSession('first-session', 'add', box.lane, 'Planned in the first session')).code, 0, 'one agent session coordinates');
  assert.equal(refusal(await inSession('second-session', 'add', box.lane, 'Planned in a second session')).code, 'NOT_YOUR_CHECKOUT',
    'a second session acting as coordinator in the same main checkout is refused');
  assert.equal((await inSession('second-session', 'takeover')).code, 0, 'takeover passes the main checkout to the second session');
  assert.equal((await inSession('second-session', 'add', box.lane, 'Planned in the second session after takeover')).code, 0, 'the new session coordinates');
  assert.equal(refusal(await inSession('first-session', 'add', box.lane, 'Planned again in the first session')).code, 'NOT_YOUR_CHECKOUT',
    'the earlier session is refused after the takeover');

  // A second machine's main checkout acting as coordinator is refused, by name.
  const second = await other.cli('add', box.lane, 'Planned on the second machine');
  assert.notEqual(second.code, 0, 'a second coordinator is refused');
  assert.equal(refusal(second).code, 'COORDINATOR_HELD');
  const firstName = `computer ${JSON.parse(readFileSync(box.linkFile, 'utf8')).machine.slice(-8)}`;
  const secondName = `computer ${other.machine.slice(-8)}`;
  assert.notEqual(firstName, secondName, 'the two linked computers have different names');
  assert.ok(refusal(second).message.includes(firstName), `the refusal names the holding computer: ${refusal(second).message}`);
  assert.doesNotMatch(refusal(second).message, new RegExp(hostname(), 'u'), 'the name carries no host name');
  assert.match(refusal(second).message, /pullboard takeover/u, 'the refusal names the takeover');

  // Takeover passes the coordinator to the second machine, and the first is then refused by name.
  const taken = await other.cli('takeover');
  assert.equal(taken.code, 0, `takeover passes the coordinator: ${JSON.stringify(taken.document)}`);
  assert.equal(taken.document.coordinator, secondName, 'takeover reports the new holder');
  assert.equal(taken.document.previous, firstName, 'takeover reports the holder it replaced');
  assert.equal((await other.cli('add', box.lane, 'Planned on the second machine after takeover')).code, 0, 'the new holder coordinates');
  const first = await box.cli('add', box.lane, 'Planned again on the first machine');
  assert.equal(refusal(first).code, 'COORDINATOR_HELD', 'the earlier holder is now the second coordinator');
  assert.ok(refusal(first).message.includes(secondName), `the refusal names the new holder: ${refusal(first).message}`);

  // Both replicas agree on the items each holder made, and on no others.
  for (const device of [box, other]) {
    const titles = (await device.cli('list')).document.items.map(item => item.item_title);
    assert.deepEqual(titles.filter(title => title.startsWith('Planned') || title.startsWith('Still')).sort(),
      ['Planned in the first session', 'Planned in the second session after takeover', 'Planned on the first machine',
        'Planned on the second machine after takeover', 'Still planned on the first machine']);
  }
});

test('an agent session on a computer that does not hold the coordinator takes it over [E19]', { timeout: relayWorkBudgetMs(12) }, async t => { // budget: hang ceiling for two linked devices' real CLI and relay round trips; not a speed target.
  const box = await relayClientFixture(t);
  await box.link();
  const pairing = await box.cli('relay', 'pair');
  const other = await box.otherDeviceJoin(pairing.document.code);
  /** Run the second computer's real CLI from a named agent session. */
  const inSession = (...args) => relayFixtureChild(other.root, { ...other.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'second-computer-session' },
    [resolve(import.meta.dirname, '../bin/pullboard.js'), ...args, '--json']);
  assert.equal((await box.cli('add', box.lane, 'Planned on the holding computer')).code, 0, 'the first computer holds the coordinator');
  const held = await inSession('add', box.lane, 'Planned before the takeover');
  assert.equal(held.document?.error?.code, 'COORDINATOR_HELD', 'the second computer is refused by name');
  assert.match(held.document.error.message, /pullboard takeover/u, 'the refusal names the takeover');
  const taken = await inSession('takeover');
  assert.equal(taken.code, 0, `the takeover the refusal names succeeds from the agent session: ${JSON.stringify(taken.document)}`);
  assert.equal(taken.document.coordinator, `computer ${other.machine.slice(-8)}`, 'the second computer now holds the coordinator');
  assert.equal((await inSession('add', box.lane, 'Planned after the takeover')).code, 0, 'the new holder coordinates');
  assert.equal((await box.cli('add', box.lane, 'Planned again on the first computer')).document?.error?.code, 'COORDINATOR_HELD', 'the earlier holder is refused');
});

/** Simulate a long holder and a polling waiter with the real board clock and lease operation. */
test('a landing lease renewal or waiter poll writes no board event [Q1,Q2,Q3]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-lease-events-'));
  let milliseconds = Date.parse('2026-01-01T00:00:00Z');
  const board = store.openBoard(join(directory, 'board.sqlite'), { now: () => new Date(milliseconds) });
  t.after(() => { store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: directory });
  const owner = { agentId: 'coordinator', token: randomUUID(), branch: 'refs/heads/main', pid: process.pid };
  const waiter = { ...owner, token: randomUUID() };
  const granted = store.landingLeaseMove(board, { ...owner, action: 'request' });
  assert.equal(granted.acquired, true);
  assert.equal(store.landingLeaseMove(board, { ...waiter, action: 'request' }).position, 1);
  for (let second = 1; second <= 35 * 60; second += 1) {
    milliseconds += 1000;
    if (second % 5 === 0) {
      const renewed = store.landingLeaseMove(board, { ...owner, action: 'renew', generation: granted.generation });
      assert.equal(renewed.acquired, true, 'the same generation remains held throughout the simulation');
    }
    const queued = store.landingLeaseMove(board, { ...waiter, action: 'request' });
    assert.equal(queued.acquired, false, 'polling never steals a live holder');
  }
  store.landingLeaseMove(board, { ...owner, action: 'release', generation: granted.generation });
  const events = board.db.prepare("SELECT event_detail FROM event WHERE event_kind='landing_lease' ORDER BY event_id").all();
  assert.equal(events.length, 3, 'only grant, initial queue and release are board events across 35 minutes');
  const state = store.landingLeaseState(board);
  assert.equal(state.holder, null);
  assert.equal(state.line.length, 1, 'suppressing polling events does not discard the waiting command');
});

/** Initialise a second repo in the first one's sandbox, so both register in the same machine home. */
function siblingRepo(box, name, project) {
  const repo = join(box.dir, name);
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal(box.run(repo, 'init').code, 0);
  return { repo, project };
}

/** Put a repo into a named project under its own name, committed so the board reads it. */
function nameRepo(box, repo, name, project) {
  const file = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, name, project }, null, 2));
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: name the repo');
}

test("one decision list across a project's repos [N34]", { timeout: 180_000 }, async t => { // budget: hang ceiling for three real repos' CLI runs and one view process; not a speed target.
  const box = helpers.project();
  const other = siblingRepo(box, 'repo-b').repo;
  const lone = siblingRepo(box, 'repo-c').repo;
  nameRepo(box, box.repo, 'alpha', 'shop');
  nameRepo(box, other, 'beta', 'shop');
  nameRepo(box, lone, 'gamma', 'elsewhere');
  const ask = (root, text) => {
    const asked = box.run(root, 'shout', 'person', text, '--decision');
    assert.equal(asked.code, 0, asked.err);
    return Number(/as #(\d+)/.exec(asked.out)?.[1]);
  };
  const alphaId = ask(box.repo, 'Ship alpha?');
  const betaId = ask(other, 'Ship beta?');
  ask(lone, 'Ship gamma?');
  const listed = () => JSON.parse(box.run(box.repo, 'decisions', '--as', 'person', '--json').out);

  // The person sees both repos of the project, each with its repo, and not another project's.
  const text = box.run(box.repo, 'decisions', '--as', 'person');
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, new RegExp(`alpha#${alphaId} .*Ship alpha\\?`));
  assert.match(text.out, new RegExp(`beta#${betaId} .*Ship beta\\?`));
  assert.doesNotMatch(text.out, /gamma|Ship gamma/);
  const both = listed();
  assert.deepEqual(both.decisions.map(({ repo, shout_id: id }) => `${repo}#${id}`).sort(), [`alpha#${alphaId}`, `beta#${betaId}`].sort());

  // The local API lists the same decisions, each with its board and repo.
  const view = await helpers.startView(box, box.repo);
  t.after(view.stop);
  const headers = { 'x-pullboard-key': view.key };
  const boards = (await (await fetchFresh(`${view.base}/api/v1/boards`, { headers })).json()).boards;
  const alphaBoard = boards.find(entry => entry.root === box.repo);
  const betaBoard = boards.find(entry => entry.root === other);
  const api = await (await fetchFresh(`${view.base}/api/v1/decisions?board=${alphaBoard.id}`, { headers })).json();
  assert.equal(api.project, 'shop');
  assert.deepEqual(api.decisions.map(({ board, repo }) => `${repo}:${board}`).sort(), [`alpha:${alphaBoard.id}`, `beta:${betaBoard.id}`].sort());

  // Answering from the first repo closes the decision on the second repo's own board, and nowhere else.
  const answered = box.run(box.repo, 'answer', `beta#${betaId}`, 'Yes, ship it.', '--as', 'person');
  assert.equal(answered.code, 0, answered.err);
  assert.deepEqual(withBoard(other, board => store.openDecisions(board, store.PERSON)), []);
  assert.equal(withBoard(box.repo, board => store.openDecisions(board, store.PERSON)).length, 1);
  assert.deepEqual(listed().decisions.map(({ repo }) => repo), ['alpha']);
  const unknown = box.run(box.repo, 'answer', 'nowhere#1', 'x', '--as', 'person');
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.err, /PROJECT_REPO_UNKNOWN/);
});

test('two repos of a project that share a name are addressed by folder, never guessed [N34]', { timeout: 120_000 }, () => { // budget: hang ceiling for two real repos' CLI runs; not a speed target.
  const box = helpers.project();
  const other = siblingRepo(box, 'repo-twin').repo;
  nameRepo(box, box.repo, 'twin', 'shop');
  nameRepo(box, other, 'twin', 'shop');
  const ask = (root, text) => Number(/as #(\d+)/.exec(box.run(root, 'shout', 'person', text, '--decision').out)?.[1]);
  ask(box.repo, 'Ship first?');
  const secondId = ask(other, 'Ship second?');
  const listed = JSON.parse(box.run(box.repo, 'decisions', '--as', 'person', '--json').out).decisions.map(({ repo }) => repo).sort();
  assert.deepEqual(listed, ['repo', 'repo-twin']);
  const guessed = box.run(box.repo, 'answer', `twin#${secondId}`, 'yes', '--as', 'person');
  assert.notEqual(guessed.code, 0);
  assert.match(guessed.err, /PROJECT_REPO_AMBIGUOUS/);
  assert.equal(withBoard(other, board => store.openDecisions(board, store.PERSON)).length, 1, 'nothing closed on either board');
  assert.equal(box.run(box.repo, 'answer', `repo-twin#${secondId}`, 'yes', '--as', 'person').code, 0);
  assert.deepEqual(withBoard(other, board => store.openDecisions(board, store.PERSON)), []);
  assert.equal(withBoard(box.repo, board => store.openDecisions(board, store.PERSON)).length, 1, 'the same-numbered question here stays open');
});


test('a non-approver device without a signed member list receives no board key [H15,E17]', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'pullboard-handover-membership-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const box = helpers.project();
  const state = { board: withBoard(box.repo, store.boardId), repository: 'fixture/repository', login: 'alice' };
  const boardKey = randomBytes(32);
  /** Make an actual SSH signature and device key, independent of what the malicious relay asserts. */
  async function request(login) {
    const file = join(folder, login);
    const made = runFixtureChild('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file], { encoding: 'utf8' });
    assert.equal(made.status, 0, 'OpenSSH creates the private fixture signing key');
    const device = await createDeviceKeys();
    const statement = { v: 1, board: state.board, repository: state.repository, login, device: device.deviceId,
      publicKey: device.publicKey, engine: PEOPLE_VERSION, expires: Date.now() + 60_000 };
    const input = file + '.statement';
    writeFileSync(input, statementBytes(statement), { mode: 0o600 });
    const signed = runFixtureChild('ssh-keygen', ['-Y', 'sign', '-q', '-n', 'pullboard-device-key', '-f', file, input], { encoding: 'utf8' });
    assert.equal(signed.status, 0, "the request is genuinely signed by that login's SSH key");
    return { device, signingKey: file, publicKey: readFileSync(file + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' '),
      entry: { id: login, login, statement, signature: readFileSync(input + '.sig', 'utf8') } };
  }
  const outsider = await request('bob');
  const member = await request('alice');
  const body = { v: 1, board: state.board, repository: state.repository, login: 'alice' };
  const identity = { body, signature: signSshVouch(JSON.stringify(['pullboard-person-identity', body]), 'pullboard-person-identity', member.signingKey) };
  /** Present attacker-controlled relay entries while resolving SSH ownership directly for each account. */
  async function answer(person) {
    const deliveries = [];
    await handOverBoardKeys(state, boardKey, {
      root: box.repo, identity,
      async send(_state, _path, options) {
        if (options.method === 'PUT') { deliveries.push(options.body); return {}; }
        return { requests: [person.entry] };
      },
      async githubKeys(login) { return login === person.entry.login ? [person.publicKey] : []; },
    }, { err() {} });
    assert.equal(deliveries.length, 1, 'each request gets one explicit refusal or delivery');
    return deliveries[0];
  }
  const refused = await answer(outsider);
  const leaked = refused.wrapped ? await unwrapDeviceBoardKey(outsider.device.privateKey,
    JSON.parse(Buffer.from(refused.wrapped, 'base64url').toString('utf8')),
    { board: state.board, device: outsider.device.deviceId, engine: PEOPLE_VERSION }) : null;
  assert.equal(leaked !== null && Buffer.from(leaked).equals(boardKey), false, 'the outsider cannot decrypt the actual board key');
  assert.equal(refused.refused?.code, 'RELAY_NOT_MEMBER', 'a valid outsider signature cannot establish trusted board membership');
  assert.equal(Object.hasOwn(refused, 'wrapped'), false, 'the relay receives no key ciphertext it could unwrap as the outsider');
  const allowed = await answer(member);
  assert.ok(allowed.wrapped, 'the linked person can still bootstrap their own independently vouched device');
  const unwrapped = await unwrapDeviceBoardKey(member.device.privateKey,
    JSON.parse(Buffer.from(allowed.wrapped, 'base64url').toString('utf8')),
    { board: state.board, device: member.device.deviceId, engine: PEOPLE_VERSION });
  assert.deepEqual(Buffer.from(unwrapped), boardKey, 'the legitimate new device receives the actual board key');
});
