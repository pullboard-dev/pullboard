/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
import { viewApiPorts } from '../../../../view/index.js';
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import { apiBoardOpeners } from '../../../tests/fixtures/board.js';

import {
  RELAY_PRESENTATION_PORTS,
  after,
  applyEngineMove,
  assert,
  childProcess,
  existsSync,
  exportBoard,
  fetchFresh,
  helpers,
  holdForReviewQueue,
  importBoard,
  main,
  prepareEngineMove,
  presentationDigest,
  relaySnapshot,
  run,
  serveApi,
  refusalDocument,
  snapshotState,
  staleVerdictCheckFixture,
  store,
  syncBuiltinESMExports,
  test,
  withBoard,
} from '../../../tests/fixtures/scenarios/team.js';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { currentGitAdapter } from '../../../../../packages/git/index.js';
import { realGitAdapter } from '../../../../../packages/git/index.js';
import { withGitAdapter } from '../../../../../packages/git/index.js';
import { verdictProjector } from '../../../../../packages/verify/index.js';
import { temporaryRepository } from '../../../tests/fixtures/board/submit.js';

test('a verdict reads stale when main moves under its files [E8]', { timeout: 120_000 }, async t => { // budget: hang ceiling for two real replicas, CLI checks and Git history; not a speed target.
  const box = helpers.project();
  assert.equal(helpers.commitFile(box, box.repo, 'web/feature.js', 'feature = 0\nmain = 0\n', 'feat(web): baseline [G1]').status, 0);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const { check, readCheckedHeads } = staleVerdictCheckFixture(box.dir);
  run(box, box.repo, 'add', 'web', 'Feature', '--specs', 'G1', '--route', 'strong', '--check', check, '--wait');
  run(box, box.web, 'claim', '1');
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.js', 'feature = 1\nmain = 0\n', 'feat(web): feature [G1]').status, 0);
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  run(box, box.web, 'submit', '1');
  const reviewer = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
  run(box, reviewer, 'join', 'web', '--route', 'strong');
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
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, projects: () => [{ root: reviewer, name: 'Verdict fixture' }], onStateBuild: () => { builds += 1; } });
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
  const phoneBefore = relaySnapshot(reviewer, {}, RELAY_PRESENTATION_PORTS);
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
    relaySnapshot(reviewer, {}, RELAY_PRESENTATION_PORTS);
    relaySnapshot(reviewer, {}, RELAY_PRESENTATION_PORTS);
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
    phoneStale = relaySnapshot(reviewer, {}, RELAY_PRESENTATION_PORTS);
  } finally { childProcess.spawnSync = originalSpawn; syncBuiltinESMExports(); }
  assert.ok(coldGit.filter(args => args.includes('diff')).length <= 2, // one candidate commit's file list plus the landed-change check c33ce2e1f5 added; never one per commit
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
  // A revert that restores the reviewed bytes now composes unchanged and reads fresh (96dd1fbad5, 60327df8ec); a further move still reads stale.
  box.git(mainEditor, 'merge', '-q', '--ff-only', 'main');
  assert.equal(helpers.commitFile(box, mainEditor, 'web/feature.js', 'feature = 1\nmain = 0\nlater = 2\n', 'feat(web): move main caller again [G1]').status, 0);
  box.git(box.repo, 'merge', '-q', '--no-ff', box.git(mainEditor, 'rev-parse', 'HEAD'), '-m', 'chore(merge): move main caller again [G1]');
  syncTrunk();
  assert.ok(items().every(item => item.item_verdict_state?.code === 'STALE_VERDICT'), 'a later move keeps an old review stale');
  const priorChecks = readCheckedHeads();
  const oldHead = box.run(reviewer, 'verify', '1', 'accept', '--note', 'Trying the old candidate is insufficient.');
  assert.equal(oldHead.code, 1);
  assert.equal(readCheckedHeads(), priorChecks, 'old candidate is refused before running its check');
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
  assert.equal(readCheckedHeads().trim().split('\n').at(-1), composed, 'the frozen check ran on the reviewed composition');
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
  assert.equal(snapshotState(relaySnapshot(peer, {}, RELAY_PRESENTATION_PORTS), peerBoardId).items[0].verdictState?.code, 'STALE_VERDICT',
    'a sealed phone presentation also fails closed until the reviewed objects arrive');
  const peerApi = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, projects: () => [{ root: peer, name: 'Peer verdict fixture' }] });
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
  assert.equal(snapshotState(relaySnapshot(peer, {}, RELAY_PRESENTATION_PORTS), peerBoardId).items[0].verdictState, undefined,
    'fetching the exact reviewed objects clears the sealed phone presentation without another board event or main move');
  assert.ok(items().every(item => !item.item_verdict_state), 'the same sealed re-review clears both replicas');
  assert.equal((await http('/state')).state.items[0].verdictState, undefined, 'a newer acceptance invalidates stale cached state');
  assert.equal((await http('/items/1')).item.verdictState, undefined);
  assert.equal(snapshotState(relaySnapshot(reviewer, {}, RELAY_PRESENTATION_PORTS), withBoard(box.repo, store.boardId)).items[0].verdictState, undefined, 'the sealed phone presentation clears after the checked re-review');
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

test('many verified items at one commit cost one ancestry check per state build, with the same freshness [E8,V8]', { timeout: 120_000 }, t => { // budget: hang ceiling for one real repo and 40 projected items; not a speed target.
  const dir = temporaryRepository(t, 'verdict-ancestry-memo-');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('commit', '--allow-empty', '-q', '-m', 'base');
  const trunk = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-q', '-m', 'item work');
  const checked = git('rev-parse', 'HEAD');
  const tip = git('rev-parse', 'HEAD');
  const projector = verdictProjector(dir, {}, { main: tip }, {
    events: () => [], acceptedVerdict: () => ({ review: { trunk, head: checked, paths: ['a.txt'] } }),
    verdictReviewProblem: () => null, trunkRef: () => 'refs/heads/main' });
  const ancestryChecks = [];
  const counting = { ...realGitAdapter, spawnSync(args, options) {
    if (args.includes('--is-ancestor')) ancestryChecks.push(args.slice(-2).join(' '));
    return realGitAdapter.spawnSync(args, options);
  } };
  const states = withGitAdapter(counting, () => {
    const counted = currentGitAdapter() === counting;
    const out = Array.from({ length: 40 }, (_, index) => projector.state({
      item_id: index + 1, item_status: 'verified', item_commit: checked, item_claim_head: trunk }));
    if (counted) assert.deepEqual(ancestryChecks, [`${checked} ${tip}`], 'one ancestry check serves all 40 items at one commit');
    return out;
  });
  assert.ok(states.every(state => state === null), 'every item reads fresh, as it did with a check per item');
});

test('legacy receipts on a cold state build spawn a bounded number of Git processes, whatever the item count [E8,V8]', { timeout: 120_000 }, t => { // budget: hang ceiling for one real repo and 80 projected items; not a speed target.
  const dir = temporaryRepository(t, 'verdict-legacy-bounded-');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('commit', '--allow-empty', '-q', '-m', 'base');
  const trunk = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-q', '-m', 'item work');
  const checked = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-q', '-m', 'main moves');
  const tip = git('rev-parse', 'HEAD');
  /** Project this many legacy-receipt items (no sealed review) and return every Git spawn made, with the states. */
  const build = (count, claimHead) => {
    const projector = verdictProjector(dir, {}, { main: tip }, {
      events: () => [], acceptedVerdict: () => null, verdictReviewProblem: () => null, trunkRef: () => 'refs/heads/main' });
    const spawns = [];
    const counting = { ...realGitAdapter, spawnSync(args, options) { spawns.push(args.join(' ')); return realGitAdapter.spawnSync(args, options); } };
    const states = withGitAdapter(counting, () => Array.from({ length: count }, (_, index) => projector.state({
      item_id: index + 1, item_status: 'verified', item_commit: checked, item_claim_head: claimHead })));
    return { spawns, states, counted: currentGitAdapter() !== counting };
  };
  for (const claimHead of [trunk, tip]) {
    const few = build(5, claimHead);
    const many = build(80, claimHead);
    assert.ok(many.states.every(state => state === null), 'every legacy item reads fresh, as it did with a read per item');
    if (few.spawns.length) assert.equal(many.spawns.length, few.spawns.length, `80 items spawn no more Git processes than 5 (claim head ${claimHead === tip ? 'at the tip' : 'behind it'})`);
    if (few.spawns.length) assert.ok(many.spawns.length <= 4, `a handful of Git reads serve all 80 items, saw ${many.spawns.length}`);
  }
});
