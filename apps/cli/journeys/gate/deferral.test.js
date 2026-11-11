/** @pullboard-test-input packages/sandbox/src/io/trusted/policy.js */
/** Deferred landing of a large affected selection at submit (C7). */
import assert from 'node:assert/strict';
import {
  runFixtureChild as spawnSync,
} from '../../tests/fixtures/child.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readdirSync } from 'node:fs';
import {
  join,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { mainPolicy } from '../../../../packages/sandbox/index.js';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import {
  BROWSER_SLOT_HELD_ENV,
  GATE_SLOT_HELD_ENV,
  GATE_SLOT_POOL_ENV,
  GATE_SLOT_TOKEN_ENV,
} from '../../../../packages/resources/index.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { fixtureCommittedPolicy } from '../../tests/fixtures/testkit.js';
import { fixtureOpenBoard } from '../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A web project whose one source file is imported by thirty test files, each recording its own run. */
function largeSelectionProject(deferAbove, { inline = false } = {}) {
  const box = e2e.project('true');
  // Landing diagnostics require TAP completion evidence on both Node 22 and Node 24.
  box.boardFile = fixtureCommittedPolicy(box, { submitGate: 'landing', affectedTests: 'node --test --test-reporter=tap',
    submitInvariants: ['web/guard.test.js'], ...(inline ? { gate: 'node --test --test-reporter=tap web/gate-check.test.js' } : { landing: { perItem: false, manualOverride: true, publish: 'separate' } }), ...(deferAbove ? { submitDeferAbove: deferAbove } : {}) });
  if (inline) {
    // An inline landing pushes its gated tip, so it needs a remote; its gate only checks for a red marker file.
    box.git(box.dir, 'init', '-q', '--bare', join(box.dir, 'origin.git'));
    box.git(box.repo, 'remote', 'add', 'origin', join(box.dir, 'origin.git'));
  }
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/core.js'), 'export const value = 1;\n');
  writeFileSync(join(box.repo, 'web/fix.js'), 'export const fixed = false;\n');
  const record = () => `import { appendFileSync } from 'node:fs';\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\n`;
  writeFileSync(join(box.repo, 'web/gate-check.test.js'), `${record()}import { existsSync } from 'node:fs';\n`
    + `test('no red marker [G1]', () => assert.equal(existsSync(new URL('./RED', import.meta.url)), false));\n`);
  writeFileSync(join(box.repo, 'web/guard.test.js'), `${record()}test('guard [G1]', () => { appendFileSync(process.env.DEFER_MARKER, 'guard\\n'); });\n`);
  for (let index = 0; index < 30; index += 1) {
    writeFileSync(join(box.repo, `web/selected-${String(index).padStart(2, '0')}.test.js`), `${record()}import { value } from './core.js';\nimport { fixed } from './fix.js';\n`
      + `test('selected ${index} [G1]', () => { appendFileSync(process.env.DEFER_MARKER, '${index}\\n'); assert.notEqual(value, 'red'); assert.ok(value !== 'needs-fix' || fixed); });\n`);
  }
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: thirty tests import one source');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.env.DEFER_MARKER = join(box.dir, 'ran.log');
  // The runner's own slot leases are not this fixture's.
  for (const name of [BROWSER_SLOT_HELD_ENV, GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV]) delete box.env[name];
  // The landing runs the deferred files on this machine: give the fixture its own gate and browser slots.
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gateSlots: 1, browserSlots: 1, gate: { memoryFloorMB: 0, timingRunner: false } });
  delete box.env.NODE_TEST_CONTEXT;
  const ran = () => existsSync(box.env.DEFER_MARKER) ? readFileSync(box.env.DEFER_MARKER, 'utf8').trim().split('\n').filter(Boolean) : [];
  /** Add, claim, change the shared source and submit one item, returning its receipt and what ran. */
  const submitChange = (value, { cwd = box.web, files = [] } = {}) => {
    const added = fixtureAdd(box.run, box.repo, 'web', `Set the value to ${value}`, '--specs', 'G1', '--criterion', 'The source exists.', '--check', 'test -f web/core.js', '--wait', '--json');
    assert.equal(added.code, 0, added.err);
    const id = JSON.parse(added.out).item.item_id;
    const claimed = box.run(cwd, 'claim', String(id));
    assert.equal(claimed.code, 0, `claim: ${claimed.err}${claimed.out}`);
    for (const [path, text] of files) writeFileSync(join(cwd, path), text);
    assert.equal(e2e.commitFile(box, cwd, files.length ? files[0][0] : 'web/core.js', files.length ? files[0][1] : `export const value = ${JSON.stringify(value)};\n`, `feat(web): set the value [G1]`).status, 0, 'the item change commits');
    rmSync(box.env.DEFER_MARKER, { force: true });
    const submitted = box.run(cwd, 'submit', String(id), '--json');
    assert.equal(submitted.code, 0, submitted.err + submitted.out);
    const receipt = JSON.parse(submitted.out);
    const proof = onLocalBoard(box, board => JSON.parse(store.events(board, { itemId: id }).findLast(row => row.event_kind === 'submit').event_detail));
    return { id, receipt, proof, ran: ran() };
  };
  /** Accept one submitted item as the coordinator, at its exact commit. */
  const accept = (id, commit) => {
    box.git(box.repo, 'switch', '-q', '--detach', commit);
    try {
      const verified = box.run(box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'The source exists.');
      assert.equal(verified.code, 0, `verify: ${verified.err}${verified.out}`);
    }
    finally { box.git(box.repo, 'switch', '-q', 'main'); }
  };
  return { box, ran, submitChange, accept };
}

/** Read a fixture's real board through its public interface. */
function onLocalBoard(box, action) {
  const board = fixtureOpenBoard(box);
  try { return action(board); } finally { store.closeBoard(board); }
}

test('a large affected selection is deferred to landing at submit [C7]', () => {
  const selected = Array.from({ length: 30 }, (_, index) => `web/selected-${String(index).padStart(2, '0')}.test.js`);
  const all = [...Array.from({ length: 30 }, (_, index) => String(index)), 'guard'].sort();
  const on = largeSelectionProject(20);
  const green = on.submitChange(2);
  assert.equal(green.receipt.gate.full, false);
  assert.equal(green.receipt.gate.deferred, true);
  assert.deepEqual(green.ran, ['guard'], 'submit ran the frozen check, static checks and the invariant file only');
  assert.deepEqual(green.proof.submissionProof.files, ['web/guard.test.js'], 'the receipt names what actually ran');
  assert.deepEqual(green.proof.submissionProof.deferredFiles, selected, 'the submission records the thirty deferred files');
  assert.match(green.proof.note, /30 affected test files deferred to the landing gate/u, 'reviewers see the deferral');
  assert.match(green.receipt.gate.report, /30 affected test files deferred to the landing gate/u);
  on.accept(green.id, green.receipt.commit);
  rmSync(on.box.env.DEFER_MARKER, { force: true });
  const landed = on.box.run(on.box.repo, 'land', '--json');
  assert.equal(landed.code, 0, landed.err + landed.out);
  assert.deepEqual(JSON.parse(landed.out).landed, [green.id]);
  assert.deepEqual(on.ran().sort(), all, 'landing ran every deferred file before the item landed');

  const red = on.submitChange('red');
  assert.deepEqual(red.ran, ['guard'], 'a red deferred file is not run at submit');
  on.accept(red.id, red.receipt.commit);
  const blocked = on.box.run(on.box.repo, 'land', '--json');
  assert.equal(blocked.code, 0, blocked.err + blocked.out);
  assert.deepEqual(JSON.parse(blocked.out).landed, [], 'a red deferred selection lands nothing');
  const reopened = JSON.parse(on.box.run(on.box.repo, 'show', String(red.id), '--json').out);
  assert.notEqual(reopened.item_status, 'verified', 'the red item is sent back like a red submit');
  assert.equal(reopened.item_merged_commit, null);
  assert.ok(reopened.thread.some(entry => entry.kind === 'reopen' && /web\/selected-00\.test\.js/u.test(entry.detail.note)), 'the reopen names the failing deferred file');

  const inline = largeSelectionProject(20, { inline: true });
  const inlineRed = inline.submitChange('red');
  assert.deepEqual(inlineRed.ran, ['guard']);
  inline.accept(inlineRed.id, inlineRed.receipt.commit);
  const inlineLanding = inline.box.run(inline.box.repo, 'land', '--json');
  assert.equal(inlineLanding.code, 0, inlineLanding.err + inlineLanding.out);
  assert.deepEqual(JSON.parse(inlineLanding.out).landed, [], 'an inline landing whose gate passes anything still runs the deferred files and lands nothing on red');
  const inlineItem = JSON.parse(inline.box.run(inline.box.repo, 'show', String(inlineRed.id), '--json').out);
  assert.notEqual(inlineItem.item_status, 'verified', 'the inline red item is sent back');
  assert.equal(inlineItem.item_merged_commit, null);
  assert.ok(inline.ran().length > 1, 'the inline landing ran the deferred files');

  // Item A carries the fix B's deferred files need, and also turns the gate red; bisect removes A and rebuilds B alone.
  const split = largeSelectionProject(20, { inline: true });
  const second = join(split.box.dir, 'web-2');
  split.box.git(split.box.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  // The second seat joins on the strong route like web-1, so it may claim the strong-routed items both build.
  const secondJoin = joinFixtureSeat(split.box, second, 'web', { model: FIXTURE_MODEL });
  assert.equal(secondJoin.code, 0, `join: ${secondJoin.err}${secondJoin.out}`);
  const itemA = split.submitChange('a', { files: [['web/fix.js', 'export const fixed = true;\n'], ['web/RED', 'red\n']] });
  const itemB = split.submitChange('needs-fix', { cwd: second });
  split.accept(itemA.id, itemA.receipt.commit);
  split.accept(itemB.id, itemB.receipt.commit);
  const splitLanding = split.box.run(split.box.repo, 'land', '--json');
  assert.equal(splitLanding.code, 0, splitLanding.err + splitLanding.out);
  assert.deepEqual(JSON.parse(splitLanding.out).landed, [], 'B does not land on a rebuilt tree that lost A\'s fix');
  for (const id of [itemA.id, itemB.id]) {
    const shown = JSON.parse(split.box.run(split.box.repo, 'show', String(id), '--json').out);
    assert.notEqual(shown.item_status, 'verified', `#${id} is sent back`);
    assert.equal(shown.item_merged_commit, null);
  }
  const reopenedB = JSON.parse(split.box.run(split.box.repo, 'show', String(itemB.id), '--json').out);
  assert.ok(reopenedB.thread.some(entry => entry.kind === 'reopen' && /web\/selected-\d\d\.test\.js/u.test(entry.detail.note)), 'B is sent back for its own deferred files');

  const off = largeSelectionProject(null).submitChange(2);
  assert.equal(off.proof.submissionProof.deferredFiles, undefined);
  assert.deepEqual(off.ran.sort(), all, 'with the setting off, submit runs all thirty as today');
});

/** Locate only durable logs belonging to this private fixture's actual native landing batches. */
function deferredLandingLogs(box) {
  const directory = join(box.repo, '.git', 'pullboard', 'landings');
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true }).filter(path => path.endsWith('.log'))
    .map(path => ({ path: join(directory, path), text: readFileSync(join(directory, path), 'utf8') }));
}

test('a red deferred landing keeps its real failing file and durable log [C7]', () => {
  const project = largeSelectionProject(20, { inline: true });
  const red = project.submitChange('red');
  project.accept(red.id, red.receipt.commit);
  const result = project.box.run(project.box.repo, 'land', '--json');
  assert.equal(result.code, 0, result.err + result.out);
  const shown = JSON.parse(project.box.run(project.box.repo, 'show', String(red.id), '--json').out);
  assert.ok(shown.thread.some(entry => entry.kind === 'reopen' && /web\/selected-00\.test\.js/u.test(entry.detail.note)), 'the refusal retains the actual failing file');
  const logs = deferredLandingLogs(project.box);
  assert.ok(logs.some(log => /selected 0 \[G1\]/u.test(log.text) && /not ok/u.test(log.text)), 'a durable native landing log retains the actual failing test output');
});

test('a pre-test native policy refusal is not reported as deferred files red [C7]', () => {
  const project = largeSelectionProject(20, { inline: true });
  const missing = join(project.box.dir, 'uncommitted-policy');
  mkdirSync(missing);
  project.box.git(missing, 'init', '-q', '-b', 'main');
  const source = new URL('../../../../packages/sandbox/src/io/trusted/policy.js', import.meta.url).href;
  const launcher = `import { mainPolicy } from ${JSON.stringify(source)};\nimport { spawnSync } from 'node:child_process';\nconst files=process.argv.slice(2);\nif (!files.some(file=>file.includes('selected-'))) { const child=spawnSync(process.execPath,['--test','--test-reporter=tap',...files],{stdio:'inherit'}); process.exitCode=child.status??1; } else { try { mainPolicy(${JSON.stringify(missing)}); throw new Error('missing policy unexpectedly accepted'); } catch (error) { if (!error.code) throw error; console.log(JSON.stringify({version:1,error:{code:error.code,message:error.message,next:'restore the committed coordinator policy'}},null,2)); process.exitCode=1; } }\n`;
  writeFileSync(join(project.box.repo, 'web/policy-launcher.mjs'), launcher);
  const policy = join(project.box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(policy, 'utf8'));
  writeFileSync(policy, JSON.stringify({ ...config, affectedTests: 'node web/policy-launcher.mjs' }, null, 2));
  project.box.git(project.box.repo, 'add', '-A');
  project.box.git(project.box.repo, 'commit', '-q', '-m', 'chore: exercise a native policy refusal before tests');
  project.box.git(project.box.web, 'merge', '-q', '--ff-only', 'main');
  const ready = project.submitChange(2);
  project.accept(ready.id, ready.receipt.commit);
  rmSync(project.box.env.DEFER_MARKER, { force: true });
  const result = project.box.run(project.box.repo, 'land', '--json');
  assert.equal(result.code, 1, result.err + result.out);
  assert.equal(JSON.parse(result.out).error.code, 'NO_POLICY', 'the exact native refusal survives without a test-red wrapper');
  assert.doesNotMatch(result.out + result.err, /\d+ file\(s\) red|the deferred affected tests are red/u);
  assert.deepEqual(project.ran(), [], 'no selected test or invariant executes after the pre-test policy refusal');
  assert.ok(deferredLandingLogs(project.box).some(log => /NO_POLICY/u.test(log.text)), 'the refusal output is retained for diagnosis');
});
