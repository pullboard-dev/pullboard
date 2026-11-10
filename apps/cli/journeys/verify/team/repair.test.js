/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
import { viewApiPorts } from '../../../../view/index.js';
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import { apiBoardOpeners } from '../../../tests/fixtures/board.js';

import {
  RELAY_PRESENTATION_PORTS,
  after,
  applyEngineMove,
  assert,
  exportBoard,
  fetchFresh,
  helpers,
  importBoard,
  main,
  mkdirSync,
  pathToFileURL,
  prepareEngineMove,
  relaySnapshot,
  rmSync,
  run,
  serveApi,
  refusalDocument,
  snapshotState,
  store,
  test,
  unpackRelease,
  withBoard,
  writeFileSync,
} from '../../../tests/fixtures/scenarios/team.js';
import { join } from 'node:path';

test('clause 1: a checkout or trunk moving during verification cannot acquire proof [E8]', () => {
  const box = helpers.project();
  const reviewer = join(box.dir, 'moving-reviewer');
  const moveHead = join(box.dir, 'move-review-head');
  const moveMain = join(box.dir, 'move-review-main');
  assert.equal(helpers.commitFile(box, box.repo, 'web/stamp.txt', 'stamp\n', 'chore: the stamp the check reads [G1]').status, 0);
  const baseline = box.git(box.repo, 'rev-parse', 'main');
  const check = `test -f web/stamp.txt && grep -q '^feature = 1$' web/feature.js && if test -f '${moveHead}'; then git -C '${reviewer}' checkout -q --detach '${baseline}'; fi && if test -f '${moveMain}'; then mkdir -p '${box.repo}/web' && printf 'feature = 1\\n' > '${box.repo}/web/feature.js' && git -C '${box.repo}' add web/feature.js && git -C '${box.repo}' commit -q -m 'chore: move review trunk [G1]'; fi`;
  run(box, box.repo, 'add', 'web', 'Moving review', '--specs', 'G1', '--check', check, '--brief', 'Files: web/feature.js\nTest: the frozen check', '--criterion', 'The feature matches the caller.', '--wait');
  run(box, box.web, 'claim', '1');
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.js', 'feature = 1\n', 'feat(web): moving review feature [G1]').status, 0);
  run(box, box.web, 'submit', '1');
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  // Main moving after the submit makes its proof unreusable, so the review runs the frozen check itself.
  // The move changes a file the check names: a move that misses the check's files leaves the submit proof reusable.
  assert.equal(helpers.commitFile(box, box.repo, 'web/stamp.txt', 'moved\n', 'chore: main moves after the submit [G1]').status, 0);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
  run(box, reviewer, 'join', 'web');
  writeFileSync(moveHead, 'armed');
  const moved = box.run(reviewer, 'verify', '1', 'accept', '--note', 'The check moved the live reviewer checkout.');
  assert.equal(moved.code, 1, moved.out + moved.err);
  assert.match(moved.err, /NOT_AT_COMMIT/u);
  assert.equal(box.git(reviewer, 'rev-parse', 'HEAD'), baseline, 'the actual checkout moved while its private check was running: ' + moved.out + moved.err);
  assert.deepEqual(withBoard(box.repo, board => store.verdictsFor(board, 1)), []);
  rmSync(moveHead);
  box.git(reviewer, 'checkout', '-q', '--detach', submitted);
  const preMove = box.git(box.repo, 'rev-parse', 'main');
  writeFileSync(moveMain, 'armed');
  const mainMoved = box.run(reviewer, 'verify', '1', 'accept', '--note', 'The check moved the known main.');
  assert.equal(mainMoved.code, 1, mainMoved.out + mainMoved.err);
  assert.match(mainMoved.err, /VERDICT_TRUNK_MOVED/u);
  assert.notEqual(box.git(box.repo, 'rev-parse', 'main'), baseline);
  assert.deepEqual(withBoard(box.repo, board => store.verdictsFor(board, 1)), []);
  rmSync(moveMain);
  // The moved trunk added the item's file itself: it merges, but the reviewed patch no longer composes unchanged,
  // so verify refuses VERDICT_TRUNK_MOVED. Put main back to run the review again.
  box.git(box.repo, 'reset', '-q', '--hard', preMove);
  run(box, reviewer, 'verify', '1', 'accept', '--note', 'The candidate and known trunk stayed fixed through the complete frozen check.');
  assert.equal(withBoard(box.repo, board => store.verdictsFor(board, 1)).length, 1);
});

test('clause 2: landing retains the exact repair that passed stale re-review [E8,V8,R3]', () => {
  const box = helpers.project();
  const source = (feature, expected) => `feature = ${feature}\n${'// independent caller line\n'.repeat(12)}expected = ${expected}\n`;
  assert.equal(helpers.commitFile(box, box.repo, 'web/feature.txt', source(0, 1), 'feat(web): baseline caller [G1]').status, 0);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const check = `test "$(sed -n 's/^feature = //p' web/feature.txt)" = "$(sed -n 's/^expected = //p' web/feature.txt)"`;
  run(box, box.repo, 'add', 'web', 'Repair follows its review', '--specs', 'G1', '--check', check, '--brief', 'Files: web/feature.js\nTest: the frozen check', '--criterion', 'The feature matches the caller.', '--wait');
  run(box, box.web, 'claim', '1');
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.txt', source(1, 1), 'feat(web): original feature [G1]').status, 0);
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  run(box, box.web, 'submit', '1');
  const reviewer = join(box.dir, 'repair-reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
  run(box, reviewer, 'join', 'web');
  run(box, reviewer, 'verify', '1', 'accept', '--note', 'The original feature matches the original caller.');
  const original = withBoard(box.repo, board => store.verdictsFor(board, 1));
  assert.equal(helpers.commitFile(box, box.repo, 'web/feature.txt', source(0, 2).replace('feature = 0\n', 'feature = 0\n// the caller reads this beside the feature\n'), 'feat(web): caller now requires two [G1]').status, 0);
  // Main inserts directly beside the line the item changed: the patch no longer merges cleanly, so the accept is stale [#2896].
  assert.equal(JSON.parse(run(box, box.repo, 'show', '1', '--json')).item_verdict_state?.code, 'STALE_VERDICT');
  box.git(reviewer, 'merge', '-q', '--no-edit', '-X', 'theirs', 'main');
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

test('clause 2: an older pushed landing shows stale checked proof and a correction path across public views [E8,H16,R3]',
  { timeout: 120_000 }, async t => { // budget: hang ceiling for real Git, private push and CLI verification; not a speed target.
    const box = helpers.project();
    assert.equal(helpers.commitFile(box, box.repo, 'web/feature.txt', 'feature = 0\n', 'feat(web): legacy landing base [G1]').status, 0);
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    const base = box.git(box.repo, 'rev-parse', 'HEAD');
    run(box, box.repo, 'add', 'web', 'Legacy landing review', '--specs', 'G1', '--check', 'test -f web/feature.txt', '--brief', 'Files: web/feature.txt\nTest: the frozen check', '--criterion', 'web/feature.txt exists.', '--wait');
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
    // @pullboard-board-file migration: engine 12 imports the actual current landing history before finishing its recorded batch.
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
    const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, projects: () => [{ root: box.repo, name: 'Older landing fixture' }] });
    t.after(() => api.close());
    const address = new URL(api.url);
    const detail = await fetchFresh(address.origin + '/api/v1/boards/' + withBoard(box.repo, store.boardId) + '/items/1',
      { headers: { 'x-pullboard-key': address.searchParams.get('k') } });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).item.verdictState?.landingCode, 'LAND_ITEM_MOVED');
    assert.equal(snapshotState(relaySnapshot(box.repo, {}, RELAY_PRESENTATION_PORTS), withBoard(box.repo, store.boardId)).items[0].verdictState?.landingCode, 'LAND_ITEM_MOVED');
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
