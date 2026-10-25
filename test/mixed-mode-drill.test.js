/** Real shared-board drill; isolated frozen runs use an explicitly labelled SSH protocol stand-in [B3,R3,C7]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { receiptLog } from '../src/gate-receipt.js';
import { machineHome } from '../src/machine-home.js';
import { loadMachineSettings } from '../src/settings.js';
import { startFixtureChild } from './fixture-child.js';
import { bridgeProvider, runBridgeCLI } from './pr-bridge-fixture.js';
import { HOST, installSshStandIn } from './runner-ssh-fixture.js';
import { mixedModeProject } from './mixed-mode-drill-fixture.js';

/** Run a public command without blocking the loopback provider or fabricating its result. */
async function cli(box, cwd, env, ...args) {
  const child = startFixtureChild(process.execPath, [box.BIN, ...args], { cwd, env, signal: box.signal, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { err += chunk; });
  const [code, signal] = await once(child, 'close');
  return { code, signal, out, err };
}
/** Keep all native gate receipts, including malformed output as an assertion failure. */
function receipts(root) {
  return readFileSync(receiptLog(root), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}
/** Separate fixture actors have explicit synthetic parents; they make no claim about actual reviewer independence. */
function actors(box) {
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    store.register(board, { lane: 'coordinator', path: box.repo, parent: 'mixed-mode-fixture-reviewer' });
    store.register(board, { lane: 'web', path: box.web, parent: 'mixed-mode-fixture-local' });
    store.register(board, { lane: 'web', path: box.runner, parent: 'mixed-mode-fixture-runner' });
  } finally { store.closeBoard(board); }
}

// Direct node --test preserves the existing native runner pool under coordinator30668.
// bin/run-tests.js deliberately isolates that pool: its deterministic lane uses only the private stand-in.
test('a local developer, a runner developer and a pull-request developer share one board and one receipt format [B3,R3,C7]', { timeout: 300_000 }, async t => {
  const started = performance.now();
  const registered = loadMachineSettings().runners ?? [];
  const actual = registered.length > 0;
  const actualMachine = machineHome();
  const box = mixedModeProject(t);
  box.signal = t.signal;
  actors(box);
  const remoteEnv = { ...box.env, ...(actual ? { PULLBOARD_MACHINE_HOME: actualMachine } : { PULLBOARD_MACHINE_HOME: join(box.dir, 'stand-in-controller') }) };
  // Independent private checks join normal admission; they do not borrow the drill controller's lease.
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) {
    delete remoteEnv[key];
  }
  if (!actual) {
    const bin = join(box.dir, 'ssh-bin'), worker = join(box.dir, 'worker');
    const home = join(box.dir, 'worker-home'), machine = join(home, '.pullboard');
    for (const path of [bin, worker, home, machine]) mkdirSync(path, { recursive: true });
    installSshStandIn({ bin, worker, home, machineHome: machine, requests: join(box.dir, 'ssh-requests.jsonl') });
    remoteEnv.PATH = bin + ':' + remoteEnv.PATH;
    const added = await cli(box, box.repo, remoteEnv, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
    assert.equal(added.code, 0, added.out + added.err);
    const policy = await cli(box, box.repo, remoteEnv, 'settings', 'gate.runnersFirst', 'on', '--json');
    assert.equal(policy.code, 0, policy.out + policy.err);
  }
  const accepted = [];
  for (const [name, path, env] of [['local', box.web, box.env], ['runner', box.runner, remoteEnv]]) {
    if (name === 'runner') box.git(path, 'merge', '-q', '--ff-only', 'main');
    const added = await cli(box, box.repo, box.env, 'add', 'web', `mixed mode ${name}`, '--specs', 'G1',
      '--criterion', 'tracked project content stays green', '--check', 'node web/drill-check.cjs', '--json');
    assert.equal(added.code, 0, added.out + added.err);
    const id = JSON.parse(added.out).item.item_id;
    const claim = await cli(box, path, box.env, 'claim', String(id), '--json');
    assert.equal(claim.code, 0, claim.out + claim.err);
    assert.equal(box.commitFile(box, path, `web/${name}.js`, 'PASS\n', `feat(web): mixed mode ${name} [G1]`).status, 0);
    const commit = box.git(path, 'rev-parse', 'HEAD');
    const submitted = await cli(box, path, box.env, 'submit', String(id), '--json');
    assert.equal(submitted.code, 0, submitted.out + submitted.err);
    const before = receipts(box.repo).length;
    box.git(box.repo, 'switch', '-q', '--detach', commit);
    let reviewed;
    try { reviewed = await cli(box, box.repo, env, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'mixed-mode native proof', '--json'); }
    finally { box.git(box.repo, 'switch', '-q', 'main'); }
    assert.equal(reviewed.code, 0, reviewed.out + reviewed.err);
    const shown = await cli(box, box.repo, box.env, 'show', String(id), '--json');
    assert.equal(shown.code, 0, shown.out + shown.err);
    const item = JSON.parse(shown.out);
    assert.equal(item.item_status, 'verified');
    const verdict = item.verdicts.at(-1);
    assert.equal(verdict.verdict_commit, commit);
    assert.notEqual(verdict.verdict_by, item.item_built_by);
    const proof = receipts(box.repo).slice(before).find(receipt => receipt.kind === 'review');
    assert.ok(proof, `${name}: the accepted item links to an actual native review receipt`);
    assert.equal(proof.runner.kind, name === 'local' ? 'local' : 'ssh');
    if (name === 'runner') {
      assert.ok(actual ? registered.some(runner => runner.host === proof.runner.id) : proof.runner.id.includes(HOST));
    }
    accepted.push({ item: id, commit, verdict: verdict.verdict_id, receipt: proof });
    box.git(box.repo, 'merge', '-q', '--no-ff', '-m', `chore(merge): mixed mode ${name} [G1]`, '-m', `Pullboard-Item: #${id}`, commit);
    const landed = await cli(box, box.repo, box.env, 'merged', String(id), box.git(box.repo, 'rev-parse', 'HEAD'), '--json');
    assert.equal(landed.code, 0, landed.out + landed.err);
  }
  assert.deepEqual(Object.keys(accepted[0].receipt).sort(), Object.keys(accepted[1].receipt).sort(),
    'local and runner proofs use the same native receipt format');
  const provider = await bridgeProvider(t, box);
  box.git(box.outside, 'switch', '-q', '-c', 'outside/contribution');
  assert.equal(box.commitFile(box, box.outside, 'web/pull-request.js', 'PASS\n', 'feat(web): outside contribution [G1]').status, 0);
  const outsideHead = box.git(box.outside, 'rev-parse', 'HEAD');
  box.git(box.outside, 'push', '-q', 'origin', 'HEAD:refs/heads/outside/contribution');
  box.git(box.outside, 'push', '-q', 'origin', 'HEAD:refs/pull/70/head');
  provider.pulls.push({ number: 70, html_url: 'https://github.com/fixture/repository/pull/70', title: 'outside contribution',
    body: '', state: 'open', merged: false, user: { login: 'outside-author' },
    head: { ref: 'outside/contribution', sha: outsideHead }, base: { ref: 'main', sha: box.published } });
  const published = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(published.code, 0, published.out + published.err);
  const outsideStatus = JSON.parse(published.out).verification.find(entry => entry.number === 70);
  assert.equal(outsideStatus.state, 'failure');
  assert.match(outsideStatus.description, /not verified/u);
  const intaken = await runBridgeCLI(box, 'intake', 'https://github.com/fixture/repository/pull/70', '--lane', 'web',
    '--criterion', 'outside tracked project content stays green', '--check', 'node web/drill-check.cjs', '--json');
  assert.equal(intaken.code, 0, intaken.out + intaken.err);
  const outside = JSON.parse(intaken.out).item;
  assert.equal(outside.item_status, 'submitted');
  assert.equal(outside.item_commit, outsideHead);
  const refused = await cli(box, box.repo, box.env, 'verify', String(outside.item_id), 'accept', '--as', 'coordinator', '--note', 'must use genuine outside verification', '--json');
  assert.notEqual(refused.code, 0);
  assert.equal(JSON.parse(refused.out).error.code, 'OUTSIDE_SANDBOX_REQUIRED');
  const stillUnverified = await cli(box, box.repo, box.env, 'show', String(outside.item_id), '--json');
  assert.equal(stillUnverified.code, 0, stillUnverified.out + stillUnverified.err);
  assert.equal(JSON.parse(stillUnverified.out).item_status, 'submitted');
  for (const root of [box.repo, box.web, box.runner, box.outside]) assert.deepEqual(box.contract(root), box.baseline,
    'every developer sees the same committed spec, doctrine configuration and tracked gate');
  assert.equal(provider.requests.some(request => request.path.endsWith('/merge') && request.method !== 'GET'), false);
  assert.ok(performance.now() - started < 300_000, 'the complete drill stays under five minutes'); // budget: declared by the #989 brief, the complete drill must stay under five minutes.
  console.log('MIXED_MODE_DRILL ' + JSON.stringify({ transport: actual ? 'actual-registered-runner' : 'isolated-ssh-stand-in',
    accepted: accepted.map(({ item, commit, verdict, receipt }) => ({ item, commit, verdict, receipt })), outside: { item: outside.item_id, commit: outsideHead, state: 'not verified' } }));
});
