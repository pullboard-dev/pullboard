/** Publishing proposes only proven heads and observes a person's merge [B3,R3]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import {
  delimiter,
  join,
} from 'node:path';
import { test } from 'node:test';
import { bridgeProject, bridgeProvider, landBridgeItems, landBridgeRepair, mergeBridgeAs, runBridgeCLI } from './pr-bridge-fixture.js';
import { onBoard } from './land-board-fixture.js';
import * as store from '../src/board.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { prepareEngineMove, applyEngineMove } from '../src/engine.js';
import { PR_BRIDGE_ENGINE } from '../src/pr-bridge-engine.js';
import { configFromSource } from '../src/config.js';
import { publishVerificationStatuses } from '../src/pr-verification.js';
import { withGitFacts } from '../src/git.js';

/** Read the real private gate invocations, retaining their exact Git heads. */
function gateHeads(box) {
  return readFileSync(box.gateCalls, 'utf8').trim().split('\n').map(line => JSON.parse(line).head);
}

test("publish opens one pull request with each item's receipt and records the person's merge as the release [B3,R3]", async t => {
  const box = bridgeProject(t);
  const entries = landBridgeItems(box);
  const provider = await bridgeProvider(t, box);
  const head = box.git(box.repo, 'rev-parse', 'main');
  const result = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(result.code, 0, result.err);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), box.published,
    'opt-in PR publishing must leave the protected remote main unchanged');
  assert.equal(provider.pulls.length, 1, 'one release proposal carries both accepted items');
  const pull = provider.pulls[0];
  assert.equal(pull.head.sha, head, 'the proposed branch is the exact head the whole project gate passed');
  assert.ok(gateHeads(box).includes(head));
  for (const entry of entries) {
    assert.ok(pull.body.includes(`#${entry.id}`));
    assert.ok(pull.body.includes(entry.commit));
    assert.ok(pull.body.includes('ACCEPT'));
    assert.ok(pull.body.includes('coordinator'));
  }
  assert.ok(pull.body.includes('darwin') || pull.body.includes('linux') || pull.body.includes('win32'));
  assert.ok(pull.body.includes(process.versions.node), 'receipt environment comes from actual proof');
  assert.equal(pull.body.includes(box.dir), false, 'machine paths do not become public PR text');
  assert.equal(pull.body.includes('private one remains correct'), false, 'private criteria are not projected');
  assert.equal(provider.requests.some(r => r.path.endsWith('/merge') && r.method !== 'GET'), false);
  const again = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(again.code, 0, again.err);
  assert.equal(provider.pulls.length, 1, 'an existing same-release PR is updated rather than duplicated');

  // A person performs a real private Git merge outside the product; the bridge only observes it.
  const person = join(box.dir, 'person');
  box.git(box.dir, 'clone', '-q', '--branch', 'main', box.remote, person);
  box.git(person, 'fetch', '-q', 'origin', pull.head.ref);
  box.git(person, 'merge', '-q', '--no-ff', '-m', 'chore: person merges reviewed proposal [G1]', 'FETCH_HEAD');
  box.git(person, 'push', '-q', 'origin', 'main');
  pull.state = 'closed'; pull.merged = true;
  pull.merge_commit_sha = box.git(person, 'rev-parse', 'HEAD');
  pull.merged_by = { login: 'fixture-person', type: 'User', id: 42 };
  const observed = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(observed.code, 0, observed.err);
  assert.equal(JSON.parse(observed.out).releases[0].recognizedPerson, true);
  assert.equal(JSON.parse(observed.out).releases[0].personApproval, false);
  const facts = onBoard(box, board => entries.flatMap(entry => store.itemThread(board, entry.id)
    .filter(fact => fact.type === 'fact').map(fact => fact.text)));
  for (const entry of entries) assert.ok(facts.some(text => text.includes(pull.html_url) && text.includes(pull.merge_commit_sha)),
    `item #${entry.id} retains the observed release fact`);
  assert.equal(provider.requests.some(r => r.path.endsWith('/merge') && r.method !== 'GET'), false,
    'no product path performs a GitHub merge');
});


test('a pull request carries a verified-by-a-second-agent status and an outside pull request reads not verified [B3,R3]', async t => {
  const box = bridgeProject(t);
  landBridgeItems(box);
  const provider = await bridgeProvider(t, box);
  const published = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(published.code, 0, published.err);
  const pull = provider.pulls[0];
  const status = provider.statuses.findLast(entry => entry.sha === pull.head.sha
    && entry.context === 'pullboard/verified-by-second-agent');
  assert.equal(status?.state, 'failure',
    'the actual PR must carry not verified while its unreceipted configuration/merge commits lack second-agent proof');
  assert.match(status.description, /^not verified/u);
  assert.match(status.description, /independence is unproven/u, 'procedural receipts are explicitly unproven');

  const proven = bridgeProject(t);
  const entries = landBridgeItems(proven, { independent: true });
  assert.ok(onBoard(proven, board => entries.every(entry => store.acceptedVerdict(board, store.getItem(board, entry.id)).assurance === 'independent')),
    'the positive uses actual CLI checks and immutable independently registered fixture parent receipts');
  const github = await bridgeProvider(t, proven);
  const opened = await runBridgeCLI(proven, 'publish', '--json');
  assert.equal(opened.code, 0, opened.err);
  const native = github.pulls[0];
  const latest = head => github.statuses.findLast(entry => entry.sha === head && entry.context === 'pullboard/verified-by-second-agent');
  assert.equal(latest(native.head.sha).state, 'success', 'recorded item merges, introduced commits and trusted companion are covered');
  assert.match(latest(native.head.sha).description, /independent/u);
  const beforeRepeat = github.statuses.length;
  assert.equal((await runBridgeCLI(proven, 'publish', '--json')).code, 0);
  assert.equal(github.statuses.length, beforeRepeat, 'unchanged receipt state does not create duplicate provider statuses');

  // The outside author has an ordinary Git clone, not a disabled Pullboard hook in the board checkout.
  const outsideRoot = join(proven.dir, 'outside-author');
  proven.git(proven.dir, 'clone', '-q', '--no-hardlinks', proven.repo, outsideRoot);
  proven.git(outsideRoot, 'remote', 'set-url', 'origin', proven.remote);
  // A real Git merge object can forge both trailers, but cannot manufacture its board landing.
  const forged = proven.git(outsideRoot, 'commit-tree', proven.git(outsideRoot, 'rev-parse', 'HEAD^{tree}'),
    '-p', native.head.sha, '-p', proven.published, '-m', 'chore: outside wrapper',
    '-m', `Pullboard-Item: #${entries[0].id}\nPullboard-Companion: #${entries[0].id}`);
  proven.git(outsideRoot, 'push', '-q', 'origin', `${forged}:refs/pull/70/head`);
  const outside = { ...structuredClone(native), number: 70, head: { ref: 'outside-forged', sha: forged },
    user: { login: 'outside-author' }, updated_at: '2026-10-24T00:00:00Z' };
  github.pulls.push(outside);
  const collision = { ...structuredClone(native), number: 71, user: { login: 'outside-author' } };
  github.pulls.push(collision);
  const discovered = await runBridgeCLI(proven, 'publish', '--json');
  assert.equal(discovered.code, 0, discovered.err);
  assert.equal(latest(forged).state, 'failure');
  assert.equal(latest(native.head.sha).state, 'failure', 'an outside PR sharing a head cannot borrow the native PR green status');
  assert.ok(JSON.parse(discovered.out).verification.find(entry => entry.number === 70).intake.includes('pullboard intake'));
  collision.state = 'closed';
  const filed = await runBridgeCLI(proven, 'intake', 'https://github.com/fixture/repository/pull/70',
    '--lane', 'web', '--criterion', 'the outside contribution behaves correctly', '--check', 'test ! -f RED', '--json');
  assert.equal(filed.code, 0, filed.err);
  const intake = JSON.parse(filed.out).item;
  assert.equal(intake.item_status, 'submitted', 'the bridge files outside work for another agent, without certifying it');
  assert.equal(intake.item_commit, forged);
  const reconciled = await runBridgeCLI(proven, 'publish', '--json');
  assert.equal(reconciled.code, 0, reconciled.err);
  const outsideProof = JSON.parse(reconciled.out).verification.find(entry => entry.number === 70);
  assert.equal(outsideProof.state, 'failure');
  assert.ok(outsideProof.unverified.includes(forged), 'a forged item or companion trailer cannot borrow an unrelated native receipt');
  assert.equal(latest(native.head.sha).state, 'success', 'closing the unverified sharing PR restores the independently proven head');

  // A later independently checked item cannot hide an earlier unverified commit in the same PR.
  proven.git(proven.repo, 'commit', '--allow-empty', '-q', '-m', 'chore: unreviewed release bump');
  const unreviewed = proven.git(proven.repo, 'rev-parse', 'HEAD');
  const added = proven.run(proven.repo, 'add', 'web', 'independently checked later work', '--specs', 'G1',
    '--criterion', 'the later work remains correct', '--check', 'test ! -f RED', '--json');
  assert.equal(added.code, 0, added.err);
  const later = JSON.parse(added.out).item.item_id;
  landBridgeRepair(proven, later, 'web/three.js', { independent: true });
  const complete = await runBridgeCLI(proven, 'publish', '--json');
  assert.equal(complete.code, 0, complete.err);
  const proof = JSON.parse(complete.out).verification.find(entry => entry.number === native.number);
  assert.equal(proof.state, 'failure');
  assert.ok(proof.unverified.includes(unreviewed), 'every commit is checked, not only the newly verified head');
  assert.equal(latest(native.head.sha).state, 'failure');
  assert.equal(github.requests.some(request => request.path.endsWith('/merge') && request.method !== 'GET'), false);
  const grafts = join(proven.repo, '.git/info/grafts');
  writeFileSync(grafts, `${native.head.sha} ${proven.published}\n`);
  const beforeGrafts = github.statuses.length;
  try {
    const grafted = await runBridgeCLI(proven, 'publish', '--json');
    assert.notEqual(grafted.code, 0);
    assert.equal(JSON.parse(grafted.out).error.code, 'GIT_GRAFTS');
    assert.equal(github.statuses.length, beforeGrafts, 'altered local ancestry cannot publish new proof');
  } finally { rmSync(grafts); }
});


test('publication modes are opt-in and invalid values refuse before a push [B3,R3]', () => {
  assert.equal(configFromSource('{}').publish?.pullRequest ?? false, false);
  for (const mode of [false, 'release', 'item']) {
    assert.equal(configFromSource(JSON.stringify({ publish: { pullRequest: mode } })).publish.pullRequest, mode);
  }
  for (const value of [true, 'auto-merge', null, { pullRequest: 'release', merge: true }]) {
    const publish = value && typeof value === 'object' ? value : { pullRequest: value };
    assert.throws(() => configFromSource(JSON.stringify({ publish })), { code: 'BAD_CONFIG' });
  }
});

test('CI findings preserve the merged item and create one linked repair, then update the same PR [B2,R3]', async t => {
  const box = bridgeProject(t);
  const entries = landBridgeItems(box);
  const provider = await bridgeProvider(t, box);
  const first = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(first.code, 0, first.err);
  const pull = provider.pulls[0];
  const oldHead = pull.head.sha;
  provider.checks = [
    { id: 301, name: 'linux / behavior', head_sha: oldHead, status: 'completed', conclusion: 'failure',
      html_url: 'https://github.com/fixture/repository/actions/runs/301' },
    { id: 302, name: 'unattributed infrastructure', head_sha: oldHead, status: 'completed', conclusion: 'failure' },
    { id: 303, name: 'stale unrelated job', head_sha: '0'.repeat(40), status: 'completed', conclusion: 'failure' },
  ];
  provider.annotationsByRun[301] = [{ path: entries[0].file, annotation_level: 'failure' }];
  provider.annotationsByRun[302] = [];
  const observed = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(observed.code, 0, observed.err);
  const items = onBoard(box, board => store.listItems(board, { all: true }));
  const children = items.filter(item => item.item_parent_id === entries[0].id);
  assert.equal(children.length, 1);
  const repair = children[0];
  assert.equal(items.find(item => item.item_id === entries[0].id).item_status, 'verified');
  assert.equal(items.find(item => item.item_id === entries[0].id).item_merged_commit !== null, true);
  assert.equal(items.filter(item => item.item_parent_id === entries[1].id).length, 0);
  const facts = onBoard(box, board => store.itemThread(board, entries[0].id));
  assert.ok(facts.some(fact => fact.type === 'fact' && fact.text.includes('linux / behavior') && fact.text.includes('/runs/301')));
  assert.ok(JSON.parse(observed.out).unattributed.some(job => job.job === 'unattributed infrastructure'));
  assert.equal((await runBridgeCLI(box, 'publish', '--json')).code, 0);
  assert.equal(onBoard(box, board => store.listItems(board, { all: true })).filter(item => item.item_parent_id === entries[0].id).length, 1,
    'polling the same failing run creates no duplicate child');
  landBridgeRepair(box, repair.item_id, entries[0].file);
  provider.checks = [];
  const updated = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(updated.code, 0, updated.err);
  assert.equal(provider.pulls.length, 1);
  assert.notEqual(pull.head.sha, oldHead, 'the actual newly proven repair head updates the original PR');
  assert.ok(pull.body.includes(`#${repair.item_id}`));
  assert.ok(gateHeads(box).includes(pull.head.sha));
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), box.published);
});

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
  const source = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const replica = store.openBoard(join(box.dir, 'replica.sqlite'));
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
  assert.throws(() => store.recordPublishFinding(source, { ...request, agentId: 'web-1' }), { code: 'COORDINATOR_ONLY' });
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
  const trace = join(box.dir, 'proof-git-calls.log'), traceBin = join(box.dir, 'proof-bin');
  mkdirSync(traceBin);
  const shim = join(traceBin, 'git');
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PB_PROOF_GIT_CALLS"\nexec "$PB_PROOF_REAL_GIT" "$@"\n`);
  chmodSync(shim, 0o755);
  const before = { PATH: process.env.PATH, PB_PROOF_GIT_CALLS: process.env.PB_PROOF_GIT_CALLS,
    PB_PROOF_REAL_GIT: process.env.PB_PROOF_REAL_GIT };
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
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
    const added = box.run(box.repo, 'add', 'web', 'larger proof cohort', '--specs', 'G1',
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
