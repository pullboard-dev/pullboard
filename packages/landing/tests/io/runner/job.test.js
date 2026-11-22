/** A land job stops on RUNNER_SOURCE without moving trunk, retries a landing fault, and reuses a landing trunk already holds [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../fixtures/plan.js';
import { git } from '../../fixtures/plan.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { redundantCheckedMerge } from '../../../src/io/runner/job.js';
import { cleanGitEnvironment } from '../../../../git/index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { retryableLandingRefusal } from '../../../index.js';
import { runLandingJob } from '../../../index.js';
import { runnerSourceHold } from '../../../index.js';

const ITEM = 41;

/** A bare trunk remote holding main and one accepted item commit that adds its own file. */
function landFixture(t, files = { 'item.txt': 'item\n' }, pace = undefined) {
  const { root: dir } = privateFixtureFiles('pullboard-land-job-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { root: work, put } = fixture(t);
  const remote = join(dir, 'remote.git');
  git(dir, 'clone', '-q', '--bare', work, remote);
  git(work, 'checkout', '-q', '-b', 'item');
  for (const [file, text] of Object.entries(files)) put(file, text);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'feat: item [C7]');
  const commit = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'push', '-q', remote, 'main:refs/heads/main', `item:refs/heads/item-${ITEM}`);
  const tip = () => git(dir, '--git-dir', remote, 'rev-parse', 'refs/heads/main').trim();
  const payload = { remote, trunk: 'refs/heads/main', expect: tip(), publish: 'separate', items: [{ id: ITEM, commit, ref: `refs/heads/item-${ITEM}`, ...(pace ? { pace } : {}) }] };
  const rev = (...args) => git(dir, '--git-dir', remote, ...args).trim();
  return { dir, work, put, payload, tip, rev, workdir: join(dir, 'runner') };
}

/** The refusal a runner raises when its checkout is not the queued candidate. */
const sourceRefusal = () => Object.assign(new Error('the runner checkout is not the queued candidate'), { code: 'RUNNER_SOURCE' });

test('landing.job.runner-source-stops-the-land-job: clause 1: RUNNER_SOURCE stops the land job with trunk unmoved, and three refusals on one base hold the item [C7]', async t => {
  const box = landFixture(t);
  const before = box.tip();
  const batches = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    await assert.rejects(runLandingJob(box.payload, { workdir: box.workdir, checks: () => { throw sourceRefusal(); } }),
      error => { batches.push({ state: 'blocked', base: before, candidates: [{ id: ITEM, commit: box.payload.items[0].commit }], refusal: { code: error.code, message: error.message } }); return error.code === 'RUNNER_SOURCE'; });
    assert.equal(box.tip(), before, 'a refused landing never moves trunk');
  }
  const held = runnerSourceHold(batches, { item_id: ITEM, item_commit: box.payload.items[0].commit }, before);
  assert.equal(held.code, 'LAND_RUNNER_SOURCE_HELD');
  assert.equal(runnerSourceHold(batches.slice(0, 2), { item_id: ITEM, item_commit: box.payload.items[0].commit }, before), null, 'two refusals still retry');
});

test('landing.job.a-landing-fault-is-retryable-and: clause 1: a landing fault is retryable and the next land job lands the same item [C7,#3693]', async t => {
  const box = landFixture(t);
  const before = box.tip();
  const fault = Object.assign(new Error('every shard was refused by the runner'), { code: 'LAND_RUNNER_FAULT' });
  await assert.rejects(runLandingJob(box.payload, { workdir: box.workdir, checks: () => { throw fault; } }), error => error.code === 'LAND_RUNNER_FAULT' && retryableLandingRefusal(error.code));
  assert.equal(box.tip(), before, 'the fault landed nothing');
  const retry = await runLandingJob(box.payload, { workdir: box.workdir, checks: () => ({ ok: true }) });
  assert.equal(retry.outcome, 'landed');
  assert.deepEqual(retry.landed, [ITEM]);
  assert.notEqual(box.tip(), before, 'the retry moved trunk');
});

test('landing.job.a-landing-whose-item-trunk-already: clause 1: a landing whose item trunk already holds reuses it, runs no check and moves nothing [C7]', async t => {
  const box = landFixture(t);
  const first = await runLandingJob(box.payload, { workdir: box.workdir, checks: () => ({ ok: true }) });
  assert.deepEqual(first.landed, [ITEM]);
  const landed = box.tip();
  let checks = 0;
  const again = await runLandingJob({ ...box.payload, expect: landed }, { workdir: box.workdir, checks: () => { checks += 1; return { ok: false, detail: 'must not run' }; } });
  assert.equal(again.outcome, 'landed');
  assert.deepEqual([again.already, again.landed, checks], [[ITEM], [], 0], 'the landed receipt is reused, no gate runs');
  assert.equal(box.tip(), landed, 'trunk stays where the first landing put it');
});

/** A proof runner that is red on its first run and green on its second, the shape of a timing flake: a TAP failure naming item.txt. */
function flakyRunner(box) {
  const script = join(box.dir, 'flaky-runner.mjs'), marker = join(box.dir, 'flaky-ran');
  writeFileSync(script, [
    "import { existsSync, writeFileSync } from 'node:fs';",
    'const marker = process.argv[2];',
    "if (existsSync(marker)) { console.log('TAP version 13\\nok 1 - case a\\n1..1\\n# fail 0'); process.exit(0); }",
    "writeFileSync(marker, 'ran');",
    "console.log(\"TAP version 13\\nnot ok 1 - case a\\n  ---\\n  location: 'item.txt:1:1'\\n  ...\\n1..1\\n# fail 1\");",
    'process.exit(1);',
    ''].join('\n'));
  return { runner: `node ${script} ${marker}`, marker };
}

test('landing.job.a-land-red-that-passes-on-rerun-lands: clause 2: with payload.retryRedsOnce a proof red that passes on one rerun of the same tree lands, and without it the same red holds [C7,#11744]', async t => {
  const held = landFixture(t), { runner: heldRunner } = flakyRunner(held);
  const off = await runLandingJob({ ...held.payload, proof: { runner: heldRunner, files: ['item.txt'] } }, { workdir: held.workdir });
  assert.notEqual(off.outcome, 'landed', 'off, the red returns the item');
  assert.equal(off.rerun, undefined, 'off, the receipt names no rerun');
  const box = landFixture(t), { runner } = flakyRunner(box);
  const before = box.tip();
  const on = await runLandingJob({ ...box.payload, retryRedsOnce: true, proof: { runner, files: ['item.txt'] } }, { workdir: box.workdir });
  assert.equal(on.outcome, 'landed', on.detail ?? '');
  assert.deepEqual(on.landed, [ITEM]);
  assert.deepEqual(on.rerun, { files: ['item.txt'], green: true }, 'the receipt names the rerun files');
  assert.notEqual(box.tip(), before, 'the landing moved trunk');
});

/** A bare trunk remote whose main holds a cell test registry, and two accepted item commits that each add a different record to it. */
function registryFixture(t) {
  const { root: dir } = privateFixtureFiles('pullboard-land-union-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { root: work, put } = fixture(t);
  const file = 'packages/demo/tests/fixtures/registry.json';
  const body = keys => `{\n${keys.map(key => `  "${key}": {"proves":{"specs":["C7"],"claim":"${key}."}}`).join(',\n')}\n}\n`;
  put(file, body(['demo.a']));
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'feat: registry [C7]');
  const remote = join(dir, 'remote.git');
  git(dir, 'clone', '-q', '--bare', work, remote);
  const items = [42, 43].map(id => {
    git(work, 'checkout', '-q', '-b', `item-${id}`, 'main');
    put(file, body(['demo.a', `demo.item${id}`]));
    put(`item-${id}.txt`, `${id}\n`);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', `feat: item ${id} [C7]`);
    git(work, 'push', '-q', remote, `item-${id}:refs/heads/item-${id}`);
    return { id, commit: git(work, 'rev-parse', 'HEAD').trim(), ref: `refs/heads/item-${id}` };
  });
  git(work, 'push', '-q', remote, 'main:refs/heads/main');
  const rev = (...args) => git(dir, '--git-dir', remote, ...args).trim();
  const payload = { remote, trunk: 'refs/heads/main', expect: rev('rev-parse', 'refs/heads/main'), publish: 'separate', items, unionRegistries: true };
  return { payload, rev, file, workdir: join(dir, 'runner') };
}

test('landing.job.two-items-adding-registry-records-land-together: clause 2: with payload.unionRegistries on, two items that each add a record to the same cell test registry land together in one real land job [C7,U148]', async t => {
  const box = registryFixture(t);
  const receipt = await runLandingJob(box.payload, { workdir: box.workdir, checks: () => ({ ok: true }) });
  assert.equal(receipt.outcome, 'landed');
  assert.deepEqual(receipt.landed, [42, 43]);
  assert.deepEqual(Object.keys(JSON.parse(box.rev('show', `refs/heads/main:${box.file}`))), ['demo.a', 'demo.item42', 'demo.item43']);
  for (const id of [42, 43]) assert.equal(box.rev('cat-file', '-t', `refs/heads/main:item-${id}.txt`), 'blob', `#${id}'s own file landed`);
});

test('landing.job.install-runs-before-item-check: clause 1: the land job runs the payload install command in its landing checkout before the first item check [C7,#12232]', async t => {
  const box = landFixture(t);
  const receipt = await runLandingJob({ ...box.payload, install: 'echo installed > installed.marker', check: ['sh', '-c', 'test -f installed.marker'] }, { workdir: box.workdir });
  assert.equal(receipt.outcome, 'landed', JSON.stringify(receipt.detail));
  assert.deepEqual(receipt.landed, [ITEM]);
});

test('landing.job.red-install-names-command-returns-no-item: clause 2: a red install ends the land job with an outcome naming the install command and returns no item [C7,#12232]', async t => {
  const box = landFixture(t);
  const before = box.tip();
  const receipt = await runLandingJob({ ...box.payload, install: 'exit 3 # npm ci', check: ['true'] }, { workdir: box.workdir });
  assert.equal(receipt.outcome, 'install-red');
  assert.match(receipt.detail, /exit 3 # npm ci/u);
  assert.deepEqual(receipt.returned, []);
  assert.equal(box.tip(), before, 'a red install lands nothing');
});

const SPRINT_PASS = 'import { test } from "node:test";\ntest("ok", () => {});\n';
const SPRINT_FAIL = 'import { test } from "node:test";\ntest("broken", () => { throw new Error("boom"); });\n';
/** The commands a sprint land job carries: no static stage, node's own test runner over test files. */
const sprintCommands = () => ({ static: null, testCommand: [process.execPath, '--test'], testFiles: '\\.test\\.js$' });

test('landing.runner-sprint-exact.green-record-on-receipt: clause 1: a sprint land job proves its merged tree before the push and records exactTree { tree, pin, cells, result } on the receipt [C7,#12230]', async t => {
  const box = landFixture(t, { 'packages/demo/tests/ok.test.js': SPRINT_PASS }, 'sprint');
  const receipt = await runLandingJob({ ...box.payload, sprint: sprintCommands() }, { workdir: box.workdir, checks: () => ({ ok: true }) });
  assert.equal(receipt.outcome, 'landed', JSON.stringify(receipt.detail));
  assert.deepEqual(receipt.exactTree, { tree: box.rev('rev-parse', 'refs/heads/main^{tree}'), pin: receipt.trunk, cells: ['packages/demo'], result: 'green' });
});

test('landing.runner-sprint-exact.red-no-push: clause 2: a sprint job whose change breaks a test in its own folder pushes nothing, ends as a red check, and its receipt exactTree.result is red [C7,#12230]', async t => {
  const box = landFixture(t, { 'packages/demo/tests/broken.test.js': SPRINT_FAIL }, 'sprint');
  const before = box.tip();
  const receipt = await runLandingJob({ ...box.payload, sprint: sprintCommands() }, { workdir: box.workdir, checks: () => ({ ok: true }) });
  assert.equal(receipt.outcome, 'red');
  assert.equal(receipt.exactTree.result, 'red');
  assert.deepEqual(receipt.landed, []);
  assert.deepEqual(receipt.returned.map(row => row.id), [ITEM]);
  assert.equal(box.tip(), before, 'a red proof pushes nothing');
});

test('landing.runner-sprint-exact.steady-unchanged: clause 3: a job whose items all carry pace steady, or no pace, runs no sprintProof, has no exactTree key and takes the same steps as on main [C7,#12230]', async t => {
  const files = { 'packages/demo/tests/broken.test.js': SPRINT_FAIL };
  const plain = await (async () => { const box = landFixture(t, files); return runLandingJob(box.payload, { workdir: box.workdir, checks: () => ({ ok: true }) }); })();
  for (const pace of ['steady', undefined]) {
    const box = landFixture(t, files, pace);
    const receipt = await runLandingJob({ ...box.payload, sprint: sprintCommands() }, { workdir: box.workdir, checks: () => ({ ok: true }) });
    assert.equal(receipt.outcome, 'landed', JSON.stringify(receipt.detail));
    assert.equal('exactTree' in receipt, false);
    assert.deepEqual(receipt.phases.map(row => row.phase), plain.phases.map(row => row.phase));
  }
});

test('landing.io-runner-job.receipt-merged-at: clause 1: a landed receipt maps each landed item id to the committer time in ms of its merge commit [C7,#12156]', async t => {
  const box = landFixture(t);
  const receipt = await runLandingJob(box.payload, { workdir: box.workdir, checks: () => ({ ok: true }) });
  assert.equal(receipt.outcome, 'landed', JSON.stringify(receipt.detail));
  assert.deepEqual(Object.keys(receipt.mergedAt), [String(ITEM)]);
  const committed = Number(box.rev('show', '-s', '--format=%ct', receipt.merges[ITEM])) * 1000;
  assert.equal(receipt.mergedAt[ITEM], committed);
  assert.ok(Number.isInteger(committed) && committed > 0, 'a real committer time in ms');
});

test('landing.io-runner-job.receipt-merged-at-unchanged: clause 2: every other receipt field is what it was without mergedAt [C7,#12156]', async t => {
  const box = landFixture(t);
  const before = box.tip();
  const receipt = await runLandingJob(box.payload, { workdir: box.workdir, checks: () => ({ ok: true }) });
  const { mergedAt, ...rest } = receipt;
  assert.ok(mergedAt, 'the field is present');
  assert.equal(rest.outcome, 'landed');
  assert.equal(rest.trunk, box.tip());
  assert.notEqual(rest.trunk, before);
  assert.deepEqual(rest.landed, [ITEM]);
  assert.deepEqual(Object.keys(rest.merges), [String(ITEM)]);
  assert.equal(rest.merges[ITEM], rest.trunk, 'a lone item merges at the tip');
});

/** Exact C(P,Q) graph on a later B; variants each violate one required classification condition. */
function redundantFixture(t, variant = 'redundant') {
  const box = landFixture(t);
  const q = box.payload.items[0].commit;
  const a = box.payload.expect;
  const tree = git(box.work, 'rev-parse', `${q}^{tree}`).trim();
  const aTree = git(box.work, 'rev-parse', `${a}^{tree}`).trim();
  const make = (tree, parents, name) => git(box.work, 'commit-tree', tree, ...parents.flatMap(p => ['-p', p]), '-m', name).trim();
  const p = make(variant === 'source-outside-parent' ? aTree : tree, [variant === 'source-outside-parent' ? a : q], 'composition trunk');
  const parents = variant === 'one-parent' ? [p] : variant === 'three-parents' ? [p, q, a] : variant === 'reversed' ? [q, p] : [p, q];
  const cTree = variant === 'tree-change' ? aTree : variant === 'source-outside-parent' ? aTree : tree;
  const c = make(cTree, parents, 'checked composition');
  box.put('later.txt', 'later trunk change\n');
  git(box.work, 'add', '-A');
  const laterTree = git(box.work, 'write-tree').trim();
  const b = variant === 'parent-outside-base' ? a : make(laterTree, [p], 'later trunk');
  git(box.work, 'push', '-q', box.payload.remote, `${b}:refs/heads/main`, `+${c}:${box.payload.items[0].ref}`);
  box.payload.items[0].commit = c;
  return { ...box, a, b, c, p, q, tree, make };
}

test('landing.job.redundant-checked-already: clause 1: exact redundant C(P,Q) on a later fetched B uses the ordinary already receipt without merging, checking, deriving or pushing [C7,P7,#12456]', async t => {
  for (const pace of [undefined, 'steady']) {
    const box = redundantFixture(t);
    if (pace) box.payload.items[0].pace = pace;
    const payload = structuredClone(box.payload);
    const refs = box.rev('show-ref');
    const receipt = await runLandingJob(box.payload, { workdir: box.workdir, checks: () => { assert.fail('an all-already job must not check'); } });
    assert.equal(receipt.outcome, 'landed');
    assert.deepEqual([receipt.already, receipt.landed, receipt.base, receipt.trunk], [[ITEM], [], box.b, box.b]);
    assert.notEqual(receipt.base, box.a, 'the stale offer expect is not the containment base');
    assert.notEqual(box.rev('rev-parse', `${box.b}^{tree}`), box.tree, 'B has later changes; only C.tree and P.tree must match');
    assert.deepEqual(receipt.phases.map(row => row.phase), ['fetch items', 'fetch trunk'], 'no merge, derive, check or push phase');
    assert.equal('exactTree' in receipt, false);
    assert.equal(box.rev('show-ref'), refs, 'all remote refs, including the checked ref and trunk, stay fixed');
    assert.deepEqual(box.payload, payload, 'the offered checked head and ref are preserved');
  }
});

test('landing.job.redundant-checked-exclusions: clause 1: changed trees, uncontained source or first parent, reversed and non-two-parent heads remain pending and obey the ordinary check [C7,P7,#12456]', async t => {
  for (const variant of ['tree-change', 'source-outside-parent', 'parent-outside-base', 'reversed', 'one-parent', 'three-parents']) {
    const box = redundantFixture(t, variant);
    assert.equal(redundantCheckedMerge(box.work, box.c, box.b), false, variant);
    let checks = 0;
    const receipt = await runLandingJob(box.payload, { workdir: box.workdir, checks: () => { checks++; return { ok: false, detail: variant }; } });
    assert.deepEqual(receipt.already, [], variant);
    assert.equal(receipt.outcome, 'red', variant);
    assert.equal(checks, 1, `${variant}: the real pending item reaches its check`);
    assert.equal(box.tip(), box.b, `${variant}: red never pushes`);
  }
});

test('landing.job.redundant-checked-mixed: clause 2: a redundant checked head is already while a real sibling still checks and lands normally [C7,P7,#12456]', async t => {
  const box = redundantFixture(t);
  git(box.work, 'checkout', '-q', '--detach', box.b);
  box.put('sibling.txt', 'real change\n');
  git(box.work, 'add', '-A');
  git(box.work, 'commit', '-qm', 'feat: sibling [C7]');
  const sibling = git(box.work, 'rev-parse', 'HEAD').trim();
  git(box.work, 'push', '-q', box.payload.remote, `${sibling}:refs/heads/item-42`);
  box.payload.items.push({ id: 42, commit: sibling, ref: 'refs/heads/item-42', pace: 'steady' });
  const checked = [];
  const receipt = await runLandingJob(box.payload, { workdir: box.workdir, checks: context => { checked.push(context.items); return { ok: true }; } });
  assert.equal(receipt.outcome, 'landed', receipt.detail ?? '');
  assert.deepEqual([receipt.already, receipt.landed, checked], [[ITEM], [42], [[42]]]);
  assert.equal(box.rev('show', 'refs/heads/main:sibling.txt'), 'real change');
  assert.equal(receipt.trunk, box.tip());
  assert.notEqual(box.tip(), box.b);
});

test('landing.job.redundant-checked-sprint-excluded: clause 2: a redundant checked Sprint head still reaches its check and exact-tree proof, and a red proof cannot move trunk [C7,P7,#12456]', async t => {
  const box = redundantFixture(t);
  box.payload.items[0].pace = 'sprint';
  let checks = 0;
  const sprint = { ...sprintCommands(), static: [process.execPath, '-e', 'process.exit(3)'] };
  const receipt = await runLandingJob({ ...box.payload, sprint }, { workdir: box.workdir, checks: () => { checks++; return { ok: true }; } });
  assert.deepEqual(receipt.already, []);
  assert.equal(checks, 1);
  assert.equal(receipt.outcome, 'red');
  assert.equal(receipt.exactTree.result, 'red');
  assert.equal(box.tip(), box.b);
});

test('landing.job.redundant-checked-invalid-objects: clause 1: missing, malformed and non-commit objects and Git failures never establish redundant containment [C7,P7,#12456]', t => {
  const box = redundantFixture(t);
  const missing = 'f'.repeat(40);
  const blob = git(box.work, 'rev-parse', `${box.q}:item.txt`).trim();
  const raw = body => runFixtureGit(['hash-object', '--literally', '-t', 'commit', '-w', '--stdin'], { cwd: box.work, env: cleanGitEnvironment(), input: body, encoding: 'utf8' }).trim();
  for (const [commit, base] of [[missing, box.b], [box.c, missing], [blob, box.b], [box.c, blob], ['HEAD', box.b], [null, box.b]]) {
    assert.equal(redundantCheckedMerge(box.work, commit, base), false);
  }
  for (const body of [
    `tree ${box.tree}\nparent ${box.p}\nparent ${missing}\n\nmissing parent\n`,
    `tree ${missing}\nparent ${box.p}\nparent ${box.q}\n\nmissing tree\n`,
    `tree ${box.tree}\nparent broken\nparent ${box.q}\n\nmalformed parent\n`,
  ]) assert.equal(redundantCheckedMerge(box.work, raw(body), box.b), false);
  const brokenParent = raw(`tree ${box.tree}\nparent ${missing}\n\nmissing ancestry\n`);
  const brokenHead = raw(`tree ${box.tree}\nparent ${brokenParent}\nparent ${box.q}\n\nunknown ancestry\n`);
  assert.equal(redundantCheckedMerge(box.work, brokenHead, box.b), false, 'an ancestry error is not containment');
  assert.equal(redundantCheckedMerge(join(box.dir, 'absent'), box.c, box.b), false, 'Git execution error is not already');
  writeFileSync(join(box.work, '.git', 'info', 'grafts'), `${box.p} ${box.q}\n`);
  assert.equal(redundantCheckedMerge(box.work, box.c, box.b), false, 'grafted ancestry is not object proof');
});


test('landing.job.redundant-checked-object-identity: clause 1: replacement refs and inherited selectors cannot change the immutable redundant-merge decision [C7,P7,#12456]', t => {
  const box = redundantFixture(t);
  const changed = box.make(git(box.work, 'rev-parse', `${box.a}^{tree}`).trim(), [box.p, box.q], 'real resolution');
  git(box.work, 'replace', changed, box.c);
  git(box.work, 'replace', box.c, box.q);
  assert.equal(redundantCheckedMerge(box.work, changed, box.b), false, 'a replacement cannot hide a resolution');
  const selectors = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_NO_REPLACE_OBJECTS'];
  const saved = selectors.map(name => [name, process.env[name]]);
  try {
    process.env.GIT_DIR = join(box.dir, 'not-a-repository');
    process.env.GIT_WORK_TREE = box.dir;
    process.env.GIT_NO_REPLACE_OBJECTS = '0';
    assert.equal(redundantCheckedMerge(box.work, box.c, box.b), true, 'the clean reader sees the original objects');
  } finally {
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test('landing.job.redundant-checked-ref-moved: clause 1: a redundant shape never skips the native fetched-ref identity check [C7,P7,#12456]', async t => {
  const box = redundantFixture(t);
  box.payload.items[0].commit = box.q;
  const receipt = await runLandingJob(box.payload, { workdir: box.workdir, checks: () => { assert.fail('moved ref must stop before checks'); } });
  assert.equal(receipt.outcome, 'item-moved');
  assert.deepEqual([receipt.already, receipt.landed], [[], []]);
  assert.equal(box.tip(), box.b);
});
