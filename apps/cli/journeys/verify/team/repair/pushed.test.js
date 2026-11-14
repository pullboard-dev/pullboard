/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
import { viewApiPorts } from '../../../../../view/index.js';
/** Scenario partition: the older-pushed-landing case of repair.test.js, apart so each file keeps its budget. */
import { apiBoardOpeners } from '../../../../tests/fixtures/board.js';

import {
  RELAY_PRESENTATION_PORTS,
  applyEngineMove,
  assert,
  exportBoard,
  fetchFresh,
  helpers,
  importBoard,
  main,
  mkdirSync,
  pathToFileURL,
  relaySnapshot,
  run,
  serveApi,
  refusalDocument,
  snapshotState,
  store,
  test,
  unpackRelease,
  withBoard,
} from '../../../../tests/fixtures/scenarios/team.js';
import { join } from 'node:path';

/**
 * Project a current board export onto an older board's tables and columns, which its importer requires to match exactly.
 * Why: the current schema has tables and columns (pull jobs, runner state) engine 12 never had; the rows it knew are unchanged.
 */
function narrowedFor(document, db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => name);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get()) names.push('sqlite_sequence');
  const tables = {};
  for (const name of names) {
    const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map(column => column.name);
    tables[name] = (document.tables[name] ?? []).map(row => Object.fromEntries(columns.map(column => [column, row[column]])));
  }
  return { ...document, tables };
}

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
    oldExchange.importBoard(old, narrowedFor(withBoard(box.repo, exportBoard), old.db));
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
