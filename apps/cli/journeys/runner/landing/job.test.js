/** @pullboard-world-pin: clause 3 reads the shipped board-side offer and job queue sources to prove neither runs git or a process. */
/** A landing is a runner job: merge accepted items, push trunk only if trunk has not moved, never on the board host [P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from '../../../../../packages/git/index.js';
import { jobQueueCall } from '../../../../../packages/api/index.js';
import { offerLandingJob } from '../../../../../packages/api/index.js';
import { jobView } from '../../../../../packages/jobs/index.js';
import { fixtureCommittedGraph } from '../../../tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';
import { closeCellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { runLandingJob } from '../../../../../packages/landing/index.js';
import { takeLandingJob } from '../../../../../packages/landing/index.js';

const AS = ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'core.hooksPath=/dev/null'];

/** A real bare trunk remote with a seed commit on main, a developer clone that pushes to it, and private runner folders. */
function trunkRemote(t) {
  const { root } = privateFixtureFiles('pullboard-runner-landing-');
  const graph = fixtureCommittedGraph('pullboard-runner-landing-dev-');
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(graph.root, { recursive: true, force: true }); });
  const dev = graph.root;
  const commit = (file, text, message) => {
    writeFileSync(join(dev, file), text);
    git(dev, ['add', file]);
    git(dev, [...AS, 'commit', '-q', '-m', message]);
    return git(dev, ['rev-parse', 'HEAD']);
  };
  const seed = commit('README.md', 'seed\n', 'chore: seed');
  const remote = join(root, 'trunk.git');
  git(root, ['clone', '-q', '--bare', dev, remote]);
  git(dev, ['remote', 'add', 'origin', remote]);
  /** An accepted item: a commit on its own branch off `base`, pushed to the trunk remote under refs/heads/item/<id>. */
  const item = (id, base = seed) => {
    git(dev, ['checkout', '-q', '--detach', base]);
    const sha = commit(`item-${id}.txt`, `item ${id}\n`, `feat(core): item ${id} [P7]`);
    git(dev, ['push', '-q', 'origin', `${sha}:refs/heads/item/${id}`]);
    return { id, commit: sha, ref: `refs/heads/item/${id}` };
  };
  /** Someone else moves trunk: a direct commit on the remote's main. */
  const rival = name => {
    git(dev, ['fetch', '-q', 'origin', 'main']);
    git(dev, ['checkout', '-q', '--detach', 'FETCH_HEAD']);
    const sha = commit(`${name}.txt`, `${name}\n`, `fix(core): ${name} [P7]`);
    git(dev, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    return sha;
  };
  const tip = () => git(root, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']);
  const has = (ancestor, of = tip()) => {
    try { git(root, ['--git-dir', remote, 'merge-base', '--is-ancestor', ancestor, of]); return true; } catch { return false; }
  };
  const parents = sha => git(root, ['--git-dir', remote, 'rev-list', '--parents', '-n', '1', sha]).split(' ').slice(1);
  return { root, remote, seed, item, rival, tip, has, parents, runner: name => join(root, 'runners', name) };
}

const payloadOf = (box, items, expect = box.seed) => ({ remote: box.remote, trunk: 'refs/heads/main', expect, items });

test('clause 1: a runner landing merges the accepted item and pushes trunk when trunk is still at the expected sha [P7]', async t => {
  const box = trunkRemote(t);
  const one = box.item(1);
  const checked = [];
  const receipt = await runLandingJob(payloadOf(box, [one]), { workdir: box.runner('r1'), checks: ({ base, items }) => { checked.push({ base, items }); return { ok: true }; } });
  assert.deepEqual([receipt.outcome, receipt.attempts, receipt.base, receipt.landed, receipt.moved], ['landed', 1, box.seed, [1], []]);
  assert.equal(box.tip(), receipt.trunk, 'the pushed tip is the merged tree the runner checked');
  assert.deepEqual(box.parents(box.tip()), [box.seed, one.commit], 'one --no-ff merge of the item on the expected sha');
  assert.match(git(box.root, ['--git-dir', box.remote, 'log', '-1', '--format=%s', 'main']), /^Merge #1 onto main \[P7\]$/u);
  assert.deepEqual(checked, [{ base: box.seed, items: [1] }]);
});

test('clause 1: a push that finds trunk moved retries on the new tip, checks again there, and pushes on it [P7]', async t => {
  const box = trunkRemote(t);
  const one = box.item(1);
  let moved = null;
  const bases = [];
  const checks = ({ base }) => {
    bases.push(base);
    // Trunk moves while this landing checks, so its push must fail its compare-and-swap and start again.
    if (!moved) moved = box.rival('hotfix');
    return { ok: true };
  };
  const receipt = await runLandingJob(payloadOf(box, [one]), { workdir: box.runner('r1'), checks });
  assert.deepEqual(bases, [box.seed, moved], 'the second check ran on the tip that moved under the first');
  assert.deepEqual([receipt.outcome, receipt.attempts, receipt.base, receipt.moved], ['landed', 2, moved, [moved]]);
  assert.deepEqual(box.parents(box.tip()), [moved, one.commit], 'the landing sits on the new tip, never on the stale one');
  assert.ok(box.has(moved), 'the rival commit stays on trunk');
});

test('clause 1: a trunk that keeps moving ends the job trunk-busy with nothing pushed over it [P7]', async t => {
  const box = trunkRemote(t);
  let n = 0;
  const receipt = await runLandingJob(payloadOf(box, [box.item(1)]), { workdir: box.runner('r1'), attempts: 2, checks: () => { box.rival(`move-${++n}`); return { ok: true }; } });
  assert.deepEqual([receipt.outcome, receipt.attempts, receipt.landed], ['trunk-busy', 2, []]);
  assert.equal(box.has(receipt.base), true);
  assert.equal(git(box.root, ['--git-dir', box.remote, 'log', '-1', '--format=%s', 'main']), 'fix(core): move-2 [P7]', 'the last rival commit is still trunk');
});

test('clause 2: two landing jobs racing on two runners from one expected sha both land, neither on a stale base [P7]', async t => {
  const box = trunkRemote(t);
  const one = box.item(1), two = box.item(2);
  const bases = { a: [], b: [] };
  // Both runners merge on the same expected sha before either pushes: a real race through git. A barrier holds both
  // checks until both runners have merged; then a pushes first and b, checking until a has landed, pushes second.
  let release, aDone;
  const merged = new Set(), barrier = new Promise(resolve => { release = resolve; });
  const arrive = name => { merged.add(name); if (merged.size === 2) release(); return barrier; };
  const a$ = runLandingJob(payloadOf(box, [one]), { workdir: box.runner('a'), checks: async ({ base }) => { bases.a.push(base); await arrive('a'); return { ok: true }; } });
  const b$ = runLandingJob(payloadOf(box, [two]), { workdir: box.runner('b'), checks: async ({ base }) => {
    bases.b.push(base);
    if (bases.b.length === 1) { await arrive('b'); await aDone; }
    return { ok: true };
  } });
  aDone = a$;
  const [a, b] = await Promise.all([a$, b$]);
  assert.deepEqual([a.outcome, b.outcome], ['landed', 'landed']);
  assert.deepEqual([a.attempts, b.attempts], [1, 2], 'the slower runner lost the compare-and-swap once and retried');
  assert.deepEqual(bases.b, [box.seed, a.trunk], 'the loser checked again on the winner\'s landing');
  assert.equal(box.tip(), b.trunk);
  assert.deepEqual(box.parents(b.trunk), [a.trunk, two.commit], 'the second landing sits on the first');
  assert.deepEqual(box.parents(a.trunk), [box.seed, one.commit]);
  for (const sha of [box.seed, one.commit, two.commit, a.trunk]) assert.ok(box.has(sha), `${sha.slice(0, 8)} survives on trunk`);
});

test('clause 2: a racing duplicate of a landing finds its item on trunk and pushes nothing, so no commit lands twice or is lost [P7]', async t => {
  const box = trunkRemote(t);
  const three = box.item(3);
  let rival = null;
  // The same landing runs twice (a lapsed lease handed it to a second runner); the second lands while the first checks.
  const first = await runLandingJob(payloadOf(box, [three]), { workdir: box.runner('a'), checks: async () => {
    if (!rival) rival = await runLandingJob(payloadOf(box, [three]), { workdir: box.runner('b') });
    return { ok: true };
  } });
  assert.equal(rival.outcome, 'landed');
  // Merged within the same second, both runners build the identical merge commit, so the duplicate's push is a no-op;
  // otherwise its retry finds #3 on trunk. Either way it reports #3 once and trunk holds one merge of it.
  assert.deepEqual([first.outcome, [...first.landed, ...first.already], first.trunk], ['landed', [3], rival.trunk]);
  assert.equal(box.tip(), rival.trunk, 'trunk keeps the one landing');
  assert.equal(git(box.root, ['--git-dir', box.remote, 'rev-list', '--count', '--merges', 'main']), '1', 'one merge of #3, not two');
});

test('clause 2: a red check or a conflict leaves trunk exactly where it was [P7]', async t => {
  const box = trunkRemote(t);
  const red = await runLandingJob(payloadOf(box, [box.item(4)]), { workdir: box.runner('a'), checks: () => ({ ok: false, detail: 'unit red' }) });
  assert.deepEqual([red.outcome, red.detail], ['red', 'unit red']);
  assert.equal(box.tip(), box.seed);
  const clash = box.item(5);
  box.rival('item-5');
  const before = box.tip();
  const conflict = await runLandingJob(payloadOf(box, [clash]), { workdir: box.runner('a') });
  assert.equal(conflict.outcome, 'conflict');
  assert.equal(box.tip(), before);
});

test('clause 3: the board host only offers a row and records a receipt; the runner does every landing step [P7]', async t => {
  const box = trunkRemote(t);
  const one = box.item(1);
  const host = privateFixtureFiles('pullboard-landing-host-').root;
  t.after(() => rmSync(host, { recursive: true, force: true }));
  const file = join(host, 'board.sqlite');
  // Each board step opens and closes its own connection: the landing lives in rows, never in a board-host process.
  const onBoard = work => { const board = openCellBoard(file); try { return work(board.db); } finally { closeCellBoard(board); } };
  const config = { landing: { trunkRemote: box.remote } };
  onBoard(db => {
    assert.throws(() => offerLandingJob(db, { items: [one], expect: box.seed, config: {}, mode: 'pull' }), error => error.code === 'LANDING_TRUNK_REMOTE');
  });
  const offered = onBoard(db => offerLandingJob(db, { items: [one], expect: box.seed, config, mode: 'pull', now: 1 }));
  assert.equal(offered.kind, 'land');
  const call = body => onBoard(db => jobQueueCall(db, body, { mode: 'pull' }));
  const taken = await takeLandingJob({ call, runner: 'runner-far', workdir: box.runner('far') });
  assert.deepEqual([taken.job, taken.receipt.outcome, taken.recorded], [offered.id, 'landed', true]);
  assert.equal(box.tip(), taken.receipt.trunk);
  assert.equal(await takeLandingJob({ call, runner: 'runner-far', workdir: box.runner('far') }), null, 'a finished landing is not offered again');
  const view = onBoard(db => jobView(db, offered.id));
  assert.equal(view.steps.at(-1).payload.receipt.outcome, 'landed', 'the board keeps the runner\'s receipt');
  assert.deepEqual(readdirSync(host).filter(name => !name.startsWith('board.sqlite')), [], 'no checkout, clone or git object on the board host');
  assert.equal(existsSync(join(host, '.git')), false);
  for (const source of ['../../../../../packages/api/src/io/landing.js', '../../../../../packages/api/src/io/jobs.js']) {
    const text = readFileSync(new URL(source, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /from ['"](?:node:child_process|[./]*(?:packages\/)?git\/)/u, `${source} runs no git and no process on the board host`);
    assert.doesNotMatch(text, /git\/index\.js|child_process/u, `${source} imports no git`);
  }
});
