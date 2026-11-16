/** Public Git/CLI cells for landing hosts and a trunk held by a test defect [E27,E28,E29]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fixtureSettledMachine } from '../testkit.js';
import { reviveFixtureLocalRunner } from '../runner/local-start.js';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../../../packages/state/index.js';
import {
  readGateReceipt,
  receiptBinds,
  receiptBody,
  receiptFields,
  receiptStore,
} from '../../../../../packages/gate/index.js';
import { gateRuns } from '../../../../../packages/gate/index.js';

/** Read the private board through its public store without rewriting historical receipts. */
function boardRead(box, action, clock) {
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), clock);
  try { return action(board); } finally { store.closeBoard(board); }
}

/** Keep each actual public command result attached to a failed assertion. */
function command(box, cwd, ...args) {
  const ran = box.run(cwd, ...args, '--json');
  let document;
  try { document = JSON.parse(ran.out); } catch { document = null; }
  return { ...ran, document };
}

/** Require success before using a public command's document. */
function success(box, cwd, ...args) {
  const ran = command(box, cwd, ...args);
  assert.equal(ran.code, 0, `${args.join(' ')}: ${ran.err}${ran.out}`);
  return ran.document;
}

/** Commit fixture inputs through the normal installed hooks. */
function commit(box, root, message) {
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', message);
  return box.git(root, 'rev-parse', 'HEAD');
}

/** A real Node test passes for either item alone and fails when their changes meet. */
function fixture(helpers) {
  const box = helpers.project('node --test --test-reporter=tap web/landing.test.js');
  // The gates settle on the loopback local runner, as every submit does (#6832); no controller pin remains.
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME);
  // This is an independent Node runner; an inherited worker context makes Node skip recursive runs.
  delete box.env.NODE_TEST_CONTEXT;
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/landing.test.js'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { existsSync } from 'node:fs';",
    "test('the two changes coexist [E27,E29]', () => assert.equal(existsSync('web/a.txt') && existsSync('web/b.txt'), false));",
  ].join('\n') + '\n');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.affectedTests = 'node --test --test-reporter=tap';
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2) + '\n');
  commit(box, box.repo, 'chore: prepare the landing host fixture');
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  const output = readFileSync(join(box.repo, '.git', 'pullboard-gate.log'), 'utf8');
  assert.match(output, /^ok 1 - the two changes coexist/mu, 'the fixture gate actually executes its named test');
  assert.match(output, /^# tests 1$/mu);
  assert.match(output, /^# pass 1$/mu);
  assert.match(output, /^# skipped 0$/mu, 'an empty or recursively skipped gate is not a positive control');
  return { ...box, remote };
}

/** Keep actual nested gate output in a failed assertion before the private sandbox is removed. */
function landingEvidence(result) {
  const gates = (result.batch?.gateResults ?? []).map(gate => ({ tree: gate.tree, isGreen: gate.isGreen,
    output: gate.logPath && existsSync(gate.logPath) ? readFileSync(gate.logPath, 'utf8').slice(0, 16 * 1024) : '(no retained log)' }));
  return JSON.stringify({ result, gates });
}

/** Budget: hang ceiling for the loopback local runner to take and apply one fixture gate. */
const GATE_SETTLE_MS = 180_000;

/**
 * Wait until the item's pulled gate receipt has moved it to submitted, reviving the local runner a gate switch stopped.
 * Why: every submit offers its gate as a pull job (#6832), so the verify after a submit would race the receipt.
 */
function submittedAfterGate(box, cwd, id) {
  const deadline = Date.now() + GATE_SETTLE_MS;
  for (;;) {
    const shown = command(box, cwd, 'show', String(id), '--no-next');
    const status = shown.document?.item_status;
    if (status && status !== 'claimed') { assert.equal(status, 'submitted', `#${id} gate: ${shown.out}`); return; }
    assert.ok(Date.now() < deadline, `#${id} gate did not settle in ${GATE_SETTLE_MS} ms: ${shown.out}${shown.err}`);
    reviveFixtureLocalRunner(cwd, box.env);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

/** Build and independently verify a fixture item at its actual committed head. */
function verified(box, name, { touchTest = false } = {}) {
  const path = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', path, 'main');
  success(box, path, 'join', 'web');
  const file = `web/${name}.txt`;
  const added = success(box, box.repo, 'add', 'web', `Landing change ${name}`, '--specs', 'G1',
    '--criterion', `the ${name} change exists`, '--check', `test -f ${file}`,
    '--brief', `Files:\n- ${file}\nChange:\n- add the file\nTest:\n- The file exists`);
  const id = added.item.item_id;
  success(box, path, 'claim', String(id));
  writeFileSync(join(path, file), `${name}\n`);
  if (touchTest) writeFileSync(join(path, 'web/landing.test.js'), readFileSync(join(path, 'web/landing.test.js'), 'utf8') + '// Candidate-only test edit.\n');
  const head = commit(box, path, 'feat(web): build the landing fixture [G1]');
  success(box, path, 'submit', String(id));
  submittedAfterGate(box, path, id);
  box.git(box.repo, 'switch', '-q', '--detach', head);
  try {
    success(box, box.repo, 'verify', String(id), 'accept', '--as', 'coordinator',
      '--note', 'The real frozen file-existence check passed at this submitted head.');
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
  return { id, path, head, file };
}

/** Re-review only when the public projection requires it; unrelated trunk edits keep a fresh verdict. */
function rechecked(box, entry) {
  if (success(box, box.repo, 'show', String(entry.id)).item_verdict_state) {
    box.git(box.repo, 'switch', '-q', '--detach', entry.head);
    try {
      box.git(box.repo, 'merge', '-q', '--no-edit', 'main');
      success(box, box.repo, 'verify', String(entry.id), 'accept', '--as', 'coordinator',
        '--note', 'The frozen check passed on the submitted work composed with the updated trunk.');
    } finally { box.git(box.repo, 'switch', '-q', 'main'); }
  }
  return boardRead(box, board => JSON.parse(store.events(board, { itemId: entry.id }).findLast(event => event.event_kind === 'accept').event_detail));
}

/** S7d: a real check and gate record the host that ran them, and the receipt binds it. */
export function assertMatchingLandingHost(helpers) {
  const box = fixture(helpers);
  const entry = verified(box, 'a');
  const environment = { platform: process.platform, arch: process.arch, node: process.versions.node };
  const accepted = boardRead(box, board => store.events(board, { itemId: entry.id }).findLast(event => event.event_kind === 'accept'));
  assert.deepEqual(JSON.parse(accepted.event_detail).environment, environment,
    'a machine-run verdict records the environment that actually ran its frozen check');
  success(box, box.repo, 'gate');
  // The fixture's initial push ran the real pre-push gate. A cached CLI gate creates no new run event.
  assert.deepEqual(gateRuns(box.repo).at(-1)?.environment, environment,
    'a real gate receipt records its executor environment');
  const receipts = receiptStore(box.repo);
  const head = box.git(box.repo, 'rev-parse', 'HEAD');
  const receipt = readdirSync(receipts).map(file => readGateReceipt(receipts, file.replace(/\.json$/u, '')))
    .find(run => run?.kind === 'land' && run.head === head);
  assert.ok(receipt, 'the actual pre-push gate retained its canonical receipt for the committed trunk');
  assert.deepEqual(receipt.environment, environment);
  assert.equal(receiptBinds(receiptStore(box.repo), receipt), true);
  assert.equal(receiptBinds(receiptStore(box.repo), { ...receipt, environment: { ...environment, node: '0.0.1' } }), false,
    'changing an executor identity breaks the real gate receipt binding');
  const { environment: ignored, ...legacyReceipt } = receipt;
  assert.equal(Object.hasOwn(receiptFields(legacyReceipt), 'environment'), false);
  assert.equal(receiptBody(legacyReceipt), JSON.stringify(legacyReceipt) + '\n',
    'historical receipts keep the exact canonical bytes without a fabricated executor');

  boardRead(box, board => {
    const item = store.getItem(board, entry.id);
    const options = { agentId: 'coordinator', decision: 'ACCEPT', note: 'Replay compatibility fixture.', head: entry.head,
      digest: item.item_frozen_digest, policy: 'any', familyPolicy: 'off', check: 'green', review: JSON.parse(accepted.event_detail).review };
    const modern = prepareEngineMove(board, 'verify', [entry.id, { ...options, environment }]);
    const count = store.events(board).length;
    assert.throws(() => applyEngineMove(board, { ...modern, engine: 78 }, { sequence: 1, at: new Date().toISOString() }), { code: 'RELAY_MOVE' });
    assert.equal(store.events(board).length, count, 'an old engine cannot silently discard the new environment semantics');
    const historical = prepareEngineMove(board, 'verify', [entry.id, options]);
    assert.equal(applyEngineMove(board, { ...historical, engine: 73 }, { sequence: 1, at: new Date().toISOString() }).error, undefined);
    assert.equal(Object.hasOwn(JSON.parse(store.events(board).findLast(event => event.event_kind === 'accept').event_detail), 'environment'), false,
      'recorded legacy verdict moves replay without acquiring new metadata');
  });

  // The host-policy refusals and the peer-environment warning rode the host landing batch, which land no longer runs: it only offers
  // the runner land job (9069644c61, 1a432cf0c2, 1e1a9586af), so `land` here offers the land job to the local runner [C7].
  // The runner's land gate validates the host through constrainedLandingHost (packages/gate/src/io/execution.js).
}

/** S7e: an interaction with no item culprit files a test defect; a recorded defect never refuses a landing, which retries the gate and lands nothing until the red is corrected or waived [C7,#5862]. */
export function assertNoCulpritTrunkHold(helpers) {
  const box = fixture(helpers);
  const entries = [verified(box, 'a', { touchTest: true }), verified(box, 'b')];
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  const held = success(box, box.repo, 'land');
  assert.deepEqual(held.landed, [], landingEvidence(held));
  assert.deepEqual(held.culprits, [], 'both bisection halves pass; neither item is a proved culprit');
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), base);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), base);
  const defects = boardRead(box, board => store.events(board).filter(event => event.event_kind === 'landing-test-defect'));
  assert.equal(defects.length, 1, 'the no-culprit red files one durable test defect');
  const defect = JSON.parse(defects[0].event_detail).defect;
  assert.equal(defect.test, 'web/landing.test.js');
  assert.equal(defect.batchId, held.batch.id);
  assert.ok(boardRead(box, board => store.getItem(board, defect.item)));
  const again = command(box, box.repo, 'land');
  assert.equal(again.document?.error, undefined, 'a recorded test defect never refuses a landing [#5862]');
  assert.deepEqual(again.document?.landed, [], 'a candidate-only test edit does not look like a committed trunk correction');
  assert.equal(again.document?.batch?.state, 'test-defect', 'the unchanged red is judged again and stays a test defect');
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), base);
  boardRead(box, board => store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal',
    id: 'expired-host-fixture', test: defect.test, until: '2000-01-02', reason: 'Expired private fixture waiver.' }),
  { now: () => new Date('2000-01-01T00:00:00Z') });
  // The expired waiver is on the board; only the live waiver below releases the red.
  success(box, box.repo, 'land', '--waive', defect.test, '--until', '2099-01-01', '--reason', 'Private fixture interaction is tracked by its defect.');
  const waived = success(box, box.repo, 'land');
  assert.deepEqual(waived.landed, entries.map(entry => entry.id));
  assert.equal(waived.batch.proof.tree, box.git(waived.batch.root, 'rev-parse', 'HEAD^{tree}'));
  assert.ok(waived.batch.proof.failures.every(failure => failure.waiver), 'the red tree stays explicitly waived');
}

/** S7e: a committed correction to the held test releases the trunk without a waiver; an uncommitted edit does not [C7,#5862]. */
export function assertTrunkHoldCorrection(helpers) {
  const fixed = fixture(helpers);
  const fixedEntries = [verified(fixed, 'a'), verified(fixed, 'b')];
  assert.deepEqual(success(fixed, fixed.repo, 'land').landed, []);
  const heldTest = readFileSync(join(fixed.repo, 'web/landing.test.js'), 'utf8');
  writeFileSync(join(fixed.repo, 'web/landing.test.js'), heldTest + '// An uncommitted edit is not a correction.\n');
  assert.deepEqual(command(fixed, fixed.repo, 'land').document?.landed, [],
    'an uncommitted test edit does not release the red');
  writeFileSync(join(fixed.repo, 'web/landing.test.js'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { existsSync, readFileSync } from 'node:fs';",
    "test('the two changes coexist [E27,E29]', () => {",
    "  if (existsSync('web/a.txt') && existsSync('web/b.txt')) {",
    "    assert.equal(readFileSync('web/a.txt', 'utf8') + readFileSync('web/b.txt', 'utf8'), 'a\\nb\\n');",
    '  }',
    '});',
  ].join('\n') + '\n');
  commit(fixed, fixed.repo, 'fix(web): correct the interaction expectation [G1]');
  for (const entry of fixedEntries) rechecked(fixed, entry);
  assert.deepEqual(success(fixed, fixed.repo, 'land').landed, fixedEntries.map(entry => entry.id),
    'a correction to the held test releases the trunk without a waiver');
}
