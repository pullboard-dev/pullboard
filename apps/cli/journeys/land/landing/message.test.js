/** @pullboard-test-input packages/gate/src/io/run/tests.js */
/** A real landing writes the shared header and trailers for an item citing 36 rows and for one refrozen after its claim (RFC 0005) [C7,B3,R3]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { shellWord } from '../../../../../packages/runners/index.js';
import {
  after,
  test,
} from 'node:test';
import { parseCommitMessage } from '../../../../../packages/commits/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';

import { waitForCondition } from '../../../tests/fixtures/runner/holders.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
const projects = [];
after(async () => {
  for (const box of projects) await drainComparisons(box);
  e2e.cleanup();
});

/** Await the fixture's actual diagnostic child result before another phase uses its files or removes its repository. */
async function drainComparisons(box, signal) {
  const directory = join(box.repo, '.git/pullboard/review-comparisons');
  const jobs = existsSync(directory) ? readdirSync(directory).map(job => join(directory, job)) : [];
  await waitForCondition(() => jobs.every(job => existsSync(join(job, 'result.json'))),
    'owned comparison workers have closed', { signal });
}
const { sandbox, commitFile } = e2e;

/** The 36 approved rows Z1..Z36, in spec order. */
const ROWS = Array.from({ length: 36 }, (_, index) => `Z${index + 1}`);

/** A local-only repo with a spec of G1 and Z1..Z36, landing into its own trunk with a trivial gate. */
async function localProject({ batch = false } = {}) {
  const box = sandbox();
  const repo = join(box.dir, 'message-repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const initialized = await box.runLocal(repo, 'init');
  assert.equal(initialized.code, 0, initialized.err);
  const configFile = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, gate: 'true', verify: 'any', landing: { ...config.landing, manualOverride: true, ...(batch ? { perItem: false } : {}) }, lanes: { web: { owns: ['web/'], specs: ['G1', ...ROWS] } } }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), `# Message fixture\n\n## Goals\n- G1 [approved, must] The result exists. | gate: true\n${ROWS.map((id) => `- ${id} [approved, must] Row ${id} holds. | gate: true`).join('\n')}\n`);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: configure local landing');
  const run = box.runLocal;
  /** Finish fixture jobs before reading their state or removing their Git source. */
  const command = async (cwd, ...args) => {
    if (args[0] === 'add' || args[0] === 'submit') args.push('--wait');
    if (args[0] === 'submit' || args[0] === 'verify') args.push('--no-next');
    return run(cwd, ...args);
  };
  const project = { ...box, repo, runLocal: command };
  projects.push(project);
  return project;
}

/** Add one web item and a builder worktree that claims it. */
async function claimedItem(box, title, specs, file) {
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', title, ...(specs.length ? ['--specs', specs.join(',')] : []), '--criterion', `${file} exists`, '--check', `test -f ${file}`, '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  const made = await box.runLocal(box.repo, 'worktree', 'web', '--model', 'message-builder', '--json');
  assert.equal(made.code, 0, made.err);
  const path = JSON.parse(made.out).path;
  const claimed = await box.runLocal(path, 'claim', String(id));
  assert.equal(claimed.code, 0, claimed.err);
  return { id, path, file };
}

/** Commit, submit and accept one item as the coordinator at its submitted commit. */
async function buildAndAccept(box, entry, header = `feat(web): build ${entry.file.split('/').pop()} [Z1]`) {
  const committed = commitFile(box, entry.path, entry.file, 'built\n', header);
  assert.equal(committed.status, 0, committed.stderr);
  const submitted = await box.runLocal(entry.path, 'submit', String(entry.id), '--json');
  assert.equal(submitted.code, 0, submitted.err);
  const head = JSON.parse(submitted.out).commit;
  box.git(box.repo, 'switch', '-q', '--detach', head);
  try {
    const verdict = await box.runLocal(box.repo, 'verify', String(entry.id), 'accept', '--as', 'coordinator', '--note', `${entry.file} exists at the submitted commit`);
    assert.equal(verdict.code, 0, verdict.err);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
}

/** Move main after acceptance so landing must compose and execute its own gate. */
function advanceMain(box) {
  writeFileSync(join(box.repo, 'main-advance.txt'), 'main changed after acceptance\n');
  box.git(box.repo, 'add', 'main-advance.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: advance main before landing');
}

test('a landing batch writes ids that fit then +N, and every frozen row in spec order as the last paragraph [C7,B3,R3]', async () => {
  const box = await localProject({ batch: true });
  // 36 rows cited in scattered order: landing never refuses, and the trailer lists them in spec order.
  const many = await claimedItem(box, 'Land every cited row', [...ROWS].reverse(), 'web/many.txt');
  // Rows cited out of order, then refrozen after the claim by a coordinator correction.
  const refrozen = await claimedItem(box, 'Refrozen after the claim', ['Z9', 'Z3', 'G1'], 'web/refrozen.txt');
  const edited = await box.runLocal(box.repo, 'edit', String(refrozen.id), '--criterion', `${refrozen.file} exists after the correction`, '--reason', 'the old bar named the file without the correction');
  assert.equal(edited.code, 0, edited.err);
  const again = await box.runLocal(box.repo, 'refreeze', String(refrozen.id));
  assert.equal(again.code, 0, again.err);
  const frozenRows = JSON.parse(JSON.parse((await box.runLocal(box.repo, 'show', String(refrozen.id), '--json')).out).item_frozen).rows.map((row) => row.id);
  assert.deepEqual([...frozenRows].sort(), ['G1', 'Z3', 'Z9'], 'the refreeze froze the corrected bar with its rows');
  await buildAndAccept(box, many);
  await buildAndAccept(box, refrozen);
  advanceMain(box);

  const base = box.git(box.repo, 'rev-parse', 'main');
  const landed = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(landed.code, 0, landed.err || landed.out);
  const receipt = JSON.parse(landed.out);
  assert.deepEqual([...receipt.landed].sort(), [many.id, refrozen.id].sort(), JSON.stringify(receipt));
  const merges = box.git(box.repo, 'rev-list', '--reverse', '--first-parent', `${base}..${receipt.batch.tip}`).split('\n').filter(Boolean);
  const messages = new Map(merges.map((commit) => {
    const message = box.git(box.repo, 'log', '-1', '--format=%B', commit);
    return [parseCommitMessage(message).item, message];
  }));
  assert.equal(messages.get(many.id),
    `feat(merge): land every cited row [Z1,Z2,Z3,Z4,Z5,Z6,Z7,Z8,Z9,Z10,+26]\n\nPullboard-Item: #${many.id}\nPullboard-Rows: ${ROWS.join(',')}`);
  assert.equal(messages.get(refrozen.id),
    `feat(merge): refrozen after the claim [G1,Z3,Z9]\n\nPullboard-Item: #${refrozen.id}\nPullboard-Rows: G1,Z3,Z9`);
  for (const message of messages.values()) assert.ok(message.split('\n')[0].length <= 72, message);
  // Git's own trailer reader agrees with the shared parser.
  assert.equal(box.git(box.repo, 'log', '-1', '--format=%(trailers:key=Pullboard-Rows,valueonly)', merges.find((commit) => box.git(box.repo, 'log', '-1', '--format=%B', commit) === messages.get(many.id))), ROWS.join(','));
});

test('a rowless feat item lands under feat(merge) through the real hooks, and a seat cannot borrow that exemption [C7,B3,R3]', async () => {
  const box = await localProject();
  const rowless = await claimedItem(box, 'Rowless feature', [], 'web/rowless.txt');
  await buildAndAccept(box, rowless, 'feat(web): build the rowless feature [G1]');
  // A seat commit headed like a landing, naming the verified rowless item or an unknown one, still cites rows.
  const seat = await claimedItem(box, 'Seat work', ['G1'], 'web/seat.txt');
  for (const id of [rowless.id, 999]) {
    const forged = commitFile(box, seat.path, `web/forged-${id}.txt`, 'forged\n', `feat(merge): unrelated work\n\nPullboard-Item: #${id}`);
    assert.notEqual(forged.status, 0, `a seat commit with Pullboard-Item: #${id} is refused`);
    assert.match(forged.stderr + forged.stdout, /spec rows/u);
  }
  const base = box.git(box.repo, 'rev-parse', 'main');
  const landed = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(landed.code, 0, landed.err || landed.out);
  assert.deepEqual(JSON.parse(landed.out).landed, [rowless.id]);
  const merge = box.git(box.repo, 'rev-list', '--first-parent', '-n', '1', 'main');
  assert.notEqual(merge, base);
  assert.equal(box.git(box.repo, 'log', '-1', '--format=%B', merge), `feat(merge): rowless feature\n\nPullboard-Item: #${rowless.id}`,
    'the item keeps its feat type with no brackets and no Pullboard-Rows trailer');
});


test('a docs-only item lands green after both selected shard files complete without AbortError [C7,V4]', async t => {
  const box = await localProject();
  const log = join(box.dir, 'completed-docs-shard');
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.gate = `PULLBOARD_LANDING_SHARD=1/1 ${shellWord(process.execPath)} ${shellWord(resolve(import.meta.dirname, '../../../../../apps/cli/src/io/run/tests.js'))} test/docs-one.test.js test/docs-two.test.js`;
  config.lanes.web.owns = ['docs/'];
  writeFileSync(configFile, JSON.stringify(config));
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  for (const name of ['one', 'two']) writeFileSync(join(box.repo, `test/docs-${name}.test.js`), `import { test } from 'node:test';
import { appendFileSync } from 'node:fs';
test('docs shard ${name} completes [G1]', () => { appendFileSync(${JSON.stringify(log)}, '${name}\\n'); });
`);
  box.git(box.repo, 'add', 'pullboard.json', 'test');
  box.git(box.repo, 'commit', '-q', '-m', 'test: configure two real landing shard files [G1]');
  const entry = await claimedItem(box, 'Land a docs-only note', ['G1'], 'docs/note.md');
  await buildAndAccept(box, entry, 'docs(web): add only a landing note [G1]');
  advanceMain(box);
  await drainComparisons(box, t.signal);
  const changed = box.git(entry.path, 'diff', '--name-only', 'main...HEAD');
  assert.equal(changed, 'docs/note.md', 'the item changes only documentation');
  writeFileSync(log, '');
  const run = await box.runLocal(box.repo, 'land', '--max', '1', '--json');
  assert.equal(run.code, 0, run.err + run.out);
  const landed = JSON.parse(run.out);
  assert.deepEqual(landed.landed, [entry.id]);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').sort(), ['one', 'two'], 'both actual shard files complete once');
  assert.ok(landed.batch.gateResults.length > 0, 'a real landing gate is recorded');
  for (const gate of landed.batch.gateResults) {
    assert.equal(gate.isGreen, true);
    assert.doesNotMatch(readFileSync(gate.logPath, 'utf8'), /AbortError|This operation was aborted/u);
  }
});
