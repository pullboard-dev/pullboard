/** Real deferred importers distinguish a culprit from innocent owners of the same test [B3,R3,C7,V4]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  events,
  json,
} from './board.js';
import { settleLand } from './settle.js';
import { settleSubmit } from '../submit/settle.js';

const SHARED = ['web/shared-a.test.js', 'web/shared-b.test.js'];

/** Trace the configured full gate separately from actual Node importer executions, including their exit status. */
function tracedRunner(box) {
  const runner = join(box.dir, 'deferred-runner.cjs');
  box.deferredTrace = join(box.dir, 'deferred-trace.jsonl');
  writeFileSync(runner, [
    "const fs = require('node:fs'); const cp = require('node:child_process');",
    `const trace = ${JSON.stringify(box.deferredTrace)}; const gate = ${JSON.stringify(box.gate)};`,
    "const [kind, ...files] = process.argv.slice(2);",
    "const child = kind === 'full' ? cp.spawnSync('/bin/sh', ['-c', gate], { encoding: 'utf8' }) : cp.spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8' });",
    "const members = [1,2,3].filter(n => fs.readFileSync('web/leaf-' + n + '.js', 'utf8').includes('// item'));",
    "fs.appendFileSync(trace, JSON.stringify({ kind, files, members, code: child.status, signal: child.signal }) + '\\n');",
    "process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || ''); if (child.error) process.stderr.write(String(child.error)); process.exitCode = child.status === null ? 1 : child.status;",
  ].join('\n'));
  return `node ${JSON.stringify(runner)}`;
}

/** Give native submits a finite two-importer selection and a separate green full-gate floor. */
function deferredProject(landProject) {
  const box = landProject();
  // Fixture CLI children must run their actual TAP harness, not inherit the outer test worker context.
  delete box.env.NODE_TEST_CONTEXT;
  const runner = tracedRunner(box);
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, gate: `${runner} full`, affectedTests: `${runner} affected`,
    landing: { perItem: false, manualOverride: true, publish: 'separate' }, submitGate: 'landing', submitDeferAbove: 1 }, null, 2));
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.repo, 'web/land-0.test.js'), 'PASS\n');
  for (const n of [1, 2, 3]) writeFileSync(join(box.repo, `web/leaf-${n}.js`), 'export const value = 0;\n');
  for (const file of SHARED) writeFileSync(join(box.repo, file), [
    "import assert from 'node:assert/strict'; import { test } from 'node:test';",
    ...[1, 2, 3].map(n => `import { value as v${n} } from './leaf-${n}.js';`),
    "test('all leaf values remain compatible', () => assert.equal(v1 + v2 + v3, 0));",
  ].join('\n'));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: prepare shared deferred landing importers [G1]');
  return box;
}

/**
 * Build and submit one fixture item and wait for its pulled gate to apply: the submit event this fixture then reads
 * is the board's record of the runner's receipt, not something the submitting process wrote [P7,C7].
 */
async function submitSettled(t, { box, commitFile }, entry, contents) {
  const committed = commitFile(box, entry.path, entry.file, contents, `feat(web): build land fixture ${entry.item} [G1]`);
  assert.equal(committed.status, 0, committed.stderr);
  entry.commit = box.git(entry.path, 'rev-parse', 'HEAD');
  const queued = await box.runLocal(entry.path, 'submit', String(entry.item), '--no-next', '--json');
  assert.equal(queued.code, 0, queued.err + queued.out);
  const settled = await settleSubmit(t, box, JSON.parse(queued.out));
  assert.equal(settled.gate?.green, true, JSON.stringify(settled.gate));
  return settled;
}

/** Land the waiting queue as a pulled land job and wait for its receipt, in the shape the batch landing printed [P7,C7]. */
async function landSettled(box) {
  return settleLand(box, json(box, box.repo, 'land'));
}

/** Read completed private fixture executions rather than inferring a phase from admission counts. */
function runs(box) {
  return existsSync(box.deferredTrace) ? readFileSync(box.deferredTrace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).map(run => ({ ...run, files: run.files.map(file => file.replace(/^\.\//u, '')) })) : [];
}

/** Observe the exact native submit record; no fixture writes proof or event metadata. */
function assertDeferred(box, entry) {
  const event = events(box).findLast(row => row.item_id === entry.item && row.event_kind === 'submit');
  assert.ok(event, 'the actual submit event exists');
  const detail = JSON.parse(event.event_detail);
  assert.equal(detail.commit, entry.commit);
  assert.equal(detail.submissionProof.deferred, true);
  assert.deepEqual(detail.submissionProof.deferredFiles, SHARED, 'both shared importers were genuinely deferred');
}

/** Precommit actual badge bytes so badge refresh cannot turn a finite affected-only control into full fallback. */
function stableBadges(box) {
  assert.equal(box.run(box.repo, 'badge').code, 0);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: retain current accepted badge counts');
}

/** A finite green affected proof may adopt locally, but must never masquerade as a complete full-gate proof. */
export async function assertAffectedLandingUnstamped(t, { landProject, itemWorktree, acceptItem, commitFile }) {
  const box = deferredProject(landProject);
  const entry = itemWorktree(box, 1, 'web/leaf-1.js');
  await submitSettled(t, { box, commitFile }, entry, 'export const value = 0; // item1\n');
  assertDeferred(box, entry);
  acceptItem(box, entry);
  stableBadges(box);
  const start = runs(box).length;
  const remote = box.git(box.remote, 'rev-parse', 'main');
  const result = await landSettled(box);
  assert.deepEqual(result.landed, [entry.item]);
  assert.equal(result.batch.state, 'landed');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), result.batch.tip);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), remote);
  const observed = runs(box).slice(start);
  // The land job also runs the project's own gate on the merged tree; every run is green and the deferred importers run as affected tests [C7].
  assert.ok(observed.length > 0 && observed.every(run => run.code === 0) && observed.some(run => run.kind === 'affected'), `only real green executions ran: ${JSON.stringify(observed)}`);
  assert.ok(observed.some(run => SHARED.every(file => run.files.includes(file))));
  const tree = box.git(box.repo, 'rev-parse', 'main^{tree}');
  for (const cwd of [box.repo]) {
    const stamp = resolve(cwd, box.git(cwd, 'rev-parse', '--git-path', 'pullboard-gate-green'));
    assert.ok(!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== tree, 'affected-only adoption writes no full-gate stamp');
  }
}

/** A deferred shared-file red returns only its actual source culprit, not every innocent owner of that file. */
export async function assertDeferredBatchIsolation(t, { landProject, itemWorktree, acceptItem, commitFile }) {
  const box = deferredProject(landProject);
  const entries = [1, 2, 3].map(n => itemWorktree(box, n, `web/leaf-${n}.js`));
  entries.push(itemWorktree(box, 4, 'web/land-4.data'));
  for (const [index, entry] of entries.entries()) {
    await submitSettled(t, { box, commitFile }, entry, index < 3 ? `export const value = ${index === 0 ? 1 : 0}; // item${index + 1}\n` : 'harmless opaque input\n');
    if (index < 3) assertDeferred(box, entry);
  }
  for (const entry of entries) acceptItem(box, entry);
  const start = runs(box).length;
  const base = box.git(box.repo, 'rev-parse', 'main');
  const remote = box.git(box.remote, 'rev-parse', 'main');
  const result = await landSettled(box);
  assert.equal(result.batch.items.length, 4, 'plain land takes the whole waiting queue');
  assert.equal(result.batch.state, 'landed');
  // The land receipt returns the culprit to its builder with the failing importer named in the red's detail [C7].
  assert.deepEqual(result.returned.map(entry => entry.id), [entries[0].item]);
  assert.ok(SHARED.some(file => result.returned[0].detail.includes(file) || String(result.landJob.receipt.detail).includes(file)), `the culprit retains its actual importer failure: ${JSON.stringify(result.returned)}`);
  assert.deepEqual(result.landed, entries.slice(1).map(entry => entry.item), 'innocent shared-file owners survive isolation');
  // Under separate publish the land job parks its red item for the builder instead of reopening it [C7,#7492].
  assert.ok(['open', 'verified'].includes(json(box, box.repo, 'show', String(entries[0].item)).item_status), 'the culprit is returned, not landed');
  assert.equal(json(box, box.repo, 'show', String(entries[0].item)).item_merged_commit, null);
  for (const entry of entries.slice(1)) assert.ok(json(box, box.repo, 'show', String(entry.item)).item_merged_commit);
  assert.notEqual(result.batch.tip, base);
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), result.batch.tip);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), remote, 'local landing never publishes');
  const observed = runs(box).slice(start);
  assert.ok(observed.some(run => run.kind === 'full' && run.code === 0 && run.members.length === 3), 'the initial configured full gate really passes');
  assert.ok(observed.some(run => run.kind === 'affected' && run.code === 1 && run.signal === null && run.members.length === 3 && SHARED.every(file => run.files.includes(file))), 'its deferred shared importers really fail');
  assert.ok(observed.some(run => run.code === 1 && run.signal === null && run.members.length === 1 && run.members[0] === 1), 'the culprit is evaluated in isolation');
  assert.ok(observed.some(run => run.kind === 'affected' && run.code === 0 && run.members.join(',') === '2,3'), 'the rebuilt innocent group passes the shared importers');
}
