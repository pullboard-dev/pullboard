/** A land shard's runner fetches the landing ref its merged commit sits under, since no branch holds that commit [C7,#7818,#8198]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { checkoutCandidate } from '../../../index.js';
import { runTestGit } from '../../fixtures/git.js';
import { testGit } from '../../fixtures/git.js';
import { temporaryDirectory } from '../../../../board/tests/fixtures/board.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';
const REF = 'refs/pullboard/landing/land-1-abcd';

/** A trunk repository whose main holds one commit and whose merged commit sits only under the landing ref, with an empty runner cache folder. */
async function trunkWithLandingRef(t) {
  const trunk = temporaryDirectory('pullboard-landref-trunk-');
  const cache = temporaryDirectory('pullboard-landref-cache-');
  t.after(() => { rmSync(trunk, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); });
  const sh = async (...args) => (await runTestGit(trunk, ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args])).stdout;
  await sh('init', '-q', '-b', 'main');
  writeFileSync(join(trunk, 'tracked.txt'), 'one\n');
  await sh('add', '.');
  await sh('commit', '-q', '-m', 'one');
  const main = await sh('rev-parse', 'HEAD');
  await sh('checkout', '-q', '--detach');
  writeFileSync(join(trunk, 'merged.txt'), 'merged\n');
  await sh('add', '.');
  await sh('commit', '-q', '-m', 'merged');
  const merged = await sh('rev-parse', 'HEAD');
  await sh('update-ref', REF, merged);
  await sh('checkout', '-q', 'main');
  return { cache, trunk, main, merged };
}

/** The git option with every trunk fetch's refspecs recorded. */
function recording() {
  const fetched = [];
  return { fetched, git: { run: testGit.run, fetchTrunk: (store, trunk, refs) => { fetched.push(refs); return testGit.fetchTrunk(store, trunk, refs); } } };
}

test('clause 1: a candidate named with a refs/pullboard/landing ref is fetched by that ref, and its checkout is the merged commit [test] [C7,#7818]', async t => {
  const { cache, trunk, main, merged } = await trunkWithLandingRef(t);
  const { git, fetched } = recording();
  const checkout = await checkoutCandidate(cache, trunk, merged, 'slot-0', [main], { main, git, ref: REF });
  assert.equal(checkout.ok, true, checkout.reason);
  assert.ok(fetched.some(refs => refs.includes(`+${REF}:refs/pullboard/fetched-ref`)), `the runner fetched the landing ref: ${JSON.stringify(fetched)}`);
  assert.equal((await runTestGit(checkout.folder, ['rev-parse', 'HEAD'])).stdout, merged, 'the job runs on the merged commit');
});

test('clause 1: only a landing ref is fetched by name; any other ref, and a landing ref the remote lacks, fall back to the commit id [test] [C7,#7818]', async t => {
  const { cache, trunk, main, merged } = await trunkWithLandingRef(t);
  const other = recording();
  const named = await checkoutCandidate(cache, trunk, merged, 'slot-0', [main], { main, git: other.git, ref: 'refs/heads/main' });
  assert.equal(named.ok, true, named.reason);
  assert.ok(!other.fetched.flat().some(spec => spec.includes('refs/heads/main:')), 'a ref outside refs/pullboard/landing is never fetched by name');
  const { cache: second } = await trunkWithLandingRef(t);
  const missing = recording();
  const absent = await checkoutCandidate(second, trunk, merged, 'slot-0', [main], { main, git: missing.git, ref: 'refs/pullboard/landing/gone' });
  assert.equal(absent.ok, true, absent.reason);
  assert.ok(missing.fetched.some(refs => refs.some(spec => spec.startsWith(`+${merged}:`))), 'the commit id is fetched when the ref is not there');
});

test('clause 1: a gate-shard job whose request names a landing ref makes the serving runner fetch it before running [test] [C7,#7818]', { timeout: 60_000 }, async t => {
  const { cache, trunk, main, merged } = await trunkWithLandingRef(t);
  const { git, fetched } = recording();
  const receipts = [];
  let claimed = false;
  const reply = document => ({ status: 200, json: async () => document });
  const script = `console.log('HEAD '+require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim())`;
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    if (call.action === 'claim') {
      const first = !claimed;
      claimed = true;
      return reply({ trunk, claim: first ? { job: 'land:1:abcd:shard:1', attempt: 1, token: 't-1', candidate: merged, base: main } : null });
    }
    if (call.action === 'request') return reply({ request: { run: ['node', '-e', script], ref: REF, commits: [main], input: { main, entry: 'x', data: { main, source: merged } } } });
    if (call.action === 'receipt') receipts.push(call.receipt);
    return reply({ ok: true, renewed: true });
  };
  const stop = new AbortController();
  await serveRunner({ git, board: BOARD, runner: 'r-landref', capabilities: [], cache, jobs: 1, signal: stop.signal, fetchImpl, sleep: async () => { stop.abort(); }, timing: { idleMs: 1 } });
  assert.equal(receipts.length, 1, JSON.stringify(receipts));
  assert.ok(fetched.some(refs => refs.includes(`+${REF}:refs/pullboard/fetched-ref`)), `the serving runner fetched the landing ref: ${JSON.stringify(fetched)}`);
  assert.match(receipts[0].gate.error, new RegExp(`HEAD ${merged}`, 'u'), 'the job ran on the merged commit');
});
