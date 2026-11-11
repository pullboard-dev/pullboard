import { recordPublishFinding as nativeRecordPublishFinding } from '../../../../packages/github/index.js';
/** Publishing proposes only proven heads and observes a person's merge [B3,R3]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import {
  delimiter,
  join,
} from 'node:path';
import { test } from 'node:test';
import {
  bridgeProject,
  gateHeads,
  bridgeProvider,
  landBridgeItems,
  landBridgeRepair,
  mergeBridgeAs,
  runBridgeCLI,
} from '../../tests/fixtures/bridge.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import {
  prepareEngineMove,
  applyEngineMove,
} from '../../../../packages/state/index.js';
import { PR_BRIDGE_ENGINE } from '../../../../packages/state/light.js';
import { publishVerificationStatuses } from '../../../../packages/github/index.js';
import { withGitFacts } from '../../../../packages/git/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';


test('per-item proposals isolate each patch and never attribute bots or unlisted users as person approval [B3,R3]', async t => {
  const box = bridgeProject(t, 'item');
  const entries = landBridgeItems(box);
  const provider = await bridgeProvider(t, box);
  const result = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(result.code, 0, result.err);
  assert.equal(provider.pulls.length, 2);
  for (const entry of entries) {
    const pull = provider.pulls.find(p => p.body.includes(`#${entry.id}:`));
    assert.ok(pull);
    const other = entries.find(e => e.id !== entry.id);
    assert.equal(pull.body.includes(`#${other.id}:`), false);
    const files = box.git(box.remote, 'diff', '--name-only', box.published, pull.head.sha).split('\n');
    assert.deepEqual(files, [entry.file], 'per-item mode never duplicates the whole trunk diff into every PR');
    assert.ok(gateHeads(box).includes(pull.head.sha));
  }
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), box.published);
  mergeBridgeAs(box, provider.pulls[0], 'fixture-bot', 'Bot');
  mergeBridgeAs(box, provider.pulls[1], 'unlisted-user');
  const observed = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(observed.code, 0, observed.err);
  const facts = onBoard(box, board => entries.flatMap(entry => store.itemThread(board, entry.id)
    .filter(fact => fact.type === 'fact').map(fact => fact.text)));
  const releases = facts.filter(text => text.startsWith('{')).map(text => JSON.parse(text)).filter(fact => fact.type === 'github-release');
  assert.equal(releases.length, 2);
  assert.ok(releases.every(release => release.recognizedPerson === false && release.personApproval === false));
  assert.ok(releases.some(release => release.actor === 'fixture-bot'));
  assert.ok(releases.some(release => release.actor === 'unlisted-user'));
  assert.equal(provider.pulls.length, 2, 'cherry-picked publication commits are not proposed again merely because ancestry differs');
  assert.equal(provider.requests.some(request => request.path.endsWith('/merge') && request.method !== 'GET'), false);
});

test('publication findings replay deterministically and ordinary closed-parent guards remain intact [B2,H16,R3]', t => {
  const box = bridgeProject(t);
  const entries = landBridgeItems(box);
  const source = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const replica = openBoard(join(box.dir, 'replica.sqlite'));
  t.after(() => { store.closeBoard(source); store.closeBoard(replica); });
  const baseline = exportBoard(source);
  importBoard(replica, baseline);
  const request = { agentId: 'coordinator', item: entries[0].id, repository: 'fixture/repository', pull: 1,
    head: box.git(box.repo, 'rev-parse', 'HEAD'), failures: [{ id: 401, name: 'recorded CI job',
      url: 'https://github.com/fixture/repository/actions/runs/401', files: [entries[0].file] }] };
  const move = prepareEngineMove(source, 'recordPublishFinding', [request], { id: 'fixture-publication-finding' });
  assert.throws(() => applyEngineMove(replica, { ...move, engine: PR_BRIDGE_ENGINE - 1 },
    { sequence: 1, at: '2026-10-24T07:00:00.000Z' }), { code: 'RELAY_MOVE' });
  const options = { sequence: 1, at: '2026-10-24T07:00:00.000Z' };
  const a = applyEngineMove(source, move, options);
  const b = applyEngineMove(replica, move, options);
  assert.deepEqual(a, b);
  assert.equal(a.error, undefined);
  assert.deepEqual(applyEngineMove(replica, move, options), b);
  assert.deepEqual(exportBoard(source), exportBoard(replica));
  assert.equal(store.getItem(source, entries[0].id).item_status, 'verified');
  assert.throws(() => store.addItem(source, { by: 'coordinator', lane: 'web', title: 'ordinary child',
    criterion: 'ordinary closed parent remains refused', parentId: entries[0].id, route: 'strong' }), { code: 'PARENT_CLOSED' });
  assert.throws(() => nativeRecordPublishFinding(source, { ...request, agentId: 'web-1' }), { code: 'COORDINATOR_ONLY' });
  assert.throws(() => store.linkPublishRepair(source, { agentId: 'web-1', item: entries[0].id, repair: entries[1].id }), { code: 'COORDINATOR_ONLY' });
});


test('one publish pass computes pull request coverage once with bounded git calls [B3,R3]', async t => {
  const box = bridgeProject(t, 'item');
  landBridgeItems(box, { independent: true });
  const head = box.git(box.repo, 'rev-parse', 'main');
  const commits = box.git(box.repo, 'rev-list', `${box.published}..${head}`).split('\n').filter(Boolean);
  const pulls = [1, 2, 3].map(number => ({ number, head: { sha: head }, base: { sha: box.published }, commits: commits.length }));
  const state = { proposals: pulls.map(pull => ({ repository: 'fixture/repository', number: pull.number, head })) };
  const statuses = [];
  const client = { open: () => pulls, read: number => pulls.find(pull => pull.number === number),
    commits: () => commits.map(sha => ({ sha })), statuses: sha => statuses.filter(status => status.sha === sha),
    setStatus: (sha, value) => statuses.push({ sha, ...value }) };
  const realGit = process.env.PATH.split(delimiter).map(directory => join(directory || '.', 'git')).find(existsSync);
  assert.ok(realGit);
  const trace = join(box.dir, 'proof-git-calls.log');
  const traceBin = join(box.dir, 'proof-bin');
  mkdirSync(traceBin);
  const shim = join(traceBin, 'git');
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PB_PROOF_GIT_CALLS"\nexec "$PB_PROOF_REAL_GIT" "$@"\n`);
  chmodSync(shim, 0o755);
  const before = { PATH: process.env.PATH, PB_PROOF_GIT_CALLS: process.env.PB_PROOF_GIT_CALLS,
    PB_PROOF_REAL_GIT: process.env.PB_PROOF_REAL_GIT };
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  let itemReads = 0;
  const observed = { ...board, db: {
    exec: sql => board.db.exec(sql),
    /** Count real executions of full item reads, including the canonical imported-item join. */
    prepare(sql) {
      const statement = board.db.prepare(sql);
      if (!/^SELECT (?:[A-Za-z_]\w*\.)?\*(?:,.*?)? FROM item(?:\s|$)/iu.test(sql.replace(/\s+/gu, ' ').trim())) return statement;
      return new Proxy(statement, {
        /** Bind native SQLite methods while observing each read, even if a statement is reused. */
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== 'function') return value;
          /** Execute the original SQLite operation; the observer cannot supply query results. */
          return (...args) => {
            if (['all', 'get', 'iterate'].includes(property)) itemReads += 1;
            return Reflect.apply(value, target, args);
          };
        },
      });
    },
  } };
  try {
    process.env.PATH = traceBin + delimiter + before.PATH;
    process.env.PB_PROOF_GIT_CALLS = trace; process.env.PB_PROOF_REAL_GIT = realGit;
    const results = await withGitFacts(() => publishVerificationStatuses({ root: box.repo, board: observed,
      client, state, repository: 'fixture/repository', trustedHead: head }));
    assert.ok(results.every(result => result.state === 'success'), JSON.stringify(results));
    assert.equal(statuses.length, 1, 'provider statuses remain deduplicated by exact head');
    const calls = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).length;
    assert.equal(itemReads, 1, 'one native item/receipt cohort serves all open pull requests');
    assert.ok(calls <= 6, `coverage uses a bounded graph read, observed ${calls} Git processes`);
    const added = fixtureAdd(box.run, box.repo, 'web', 'larger proof cohort', '--specs', 'G1',
      '--criterion', 'another accepted native contribution', '--check', 'test ! -f RED', '--json');
    assert.equal(added.code, 0, added.err);
    landBridgeRepair(box, JSON.parse(added.out).item.item_id, 'web/three.js', { independent: true });
    const largerHead = box.git(box.repo, 'rev-parse', 'main');
    const largerCommits = box.git(box.repo, 'rev-list', `${box.published}..${largerHead}`).split('\n').filter(Boolean);
    for (const pull of pulls) { pull.head.sha = largerHead; pull.commits = largerCommits.length; }
    for (const proposal of state.proposals) proposal.head = largerHead;
    client.commits = () => largerCommits.map(sha => ({ sha }));
    writeFileSync(trace, ''); itemReads = 0;
    const larger = await withGitFacts(() => publishVerificationStatuses({ root: box.repo, board: observed,
      client, state, repository: 'fixture/repository', trustedHead: largerHead }));
    assert.ok(larger.every(result => result.state === 'success'), JSON.stringify(larger));
    assert.equal(itemReads, 1);
    const largerCalls = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).length;
    assert.ok(largerCalls <= calls, 'adding a native accepted item cannot add per-item Git processes');

    const provider = await bridgeProvider(t, box);
    const priorEnv = box.env;
    box.env = { ...priorEnv, PATH: traceBin + delimiter + priorEnv.PATH,
      PB_PROOF_GIT_CALLS: trace, PB_PROOF_REAL_GIT: realGit };
    writeFileSync(trace, '');
    try {
      const published = await runBridgeCLI(box, 'publish', '--json');
      assert.equal(published.code, 0, published.err + published.out);
      assert.equal(provider.pulls.length, 3, 'the real publish pass creates three isolated proposals');
      assert.equal(JSON.parse(published.out).verification.length, 3, 'final statuses include all newly created proposals');
      const walks = readFileSync(trace, 'utf8').split('\n').filter(line =>
        line.includes('log --no-decorate') && line.includes('trailers:key=Pullboard-Companion'));
      assert.equal(walks.length, 1, 'publication performs one shared proof walk after composing all proposals');
      t.diagnostic(JSON.stringify({ proofCoverage: { smallGitCalls: calls, largerGitCalls: largerCalls,
        publicationWalks: walks.length, proposals: provider.pulls.length } }));
    } finally { box.env = priorEnv; }

  } finally {
    store.closeBoard(board);
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
