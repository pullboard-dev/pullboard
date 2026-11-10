/** Inherited failures can pass submit without disguising new failures as known [V4,B3]. */
import '../../../index.js'; // This test invokes the real CLI through its public executable.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runFixtureGit } from '../../../tests/fixtures/child.js';
import * as store from '../../../../../packages/store/index.js';
import { fixtureBoard } from '../../../tests/fixtures/board.js';
import { submissionProof } from '../../../../../packages/state/light.js';
import { KNOWN_MAIN_FAILURES_ENGINE } from '../../../../../packages/state/light.js';
import { matchingMainFailures } from '../../../../../packages/landing/index.js';
import { failureSignatures } from '../../../../../packages/landing/index.js';
import { linkKnownMainReworks } from '../../../../../packages/store/index.js';
import { requireKnownMainReworks } from '../../../../../packages/store/index.js';
import { prepareEngineMove } from '../../../../../packages/state/index.js';
import { applyEngineMove } from '../../../../../packages/state/index.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { importBoard } from '../../../../../packages/store/index.js';
import { boundedMainRedShout } from '../../../src/io/commands/submit.js';

import { fixture } from '../../../tests/fixtures/submit/red.js';
import { cli } from '../../../tests/fixtures/submit/red.js';
import { submittedProof } from '../../../tests/fixtures/submit/red.js';
import { source } from '../../../tests/fixtures/submit/red.js';

test('submit accepts a test that fails the same way on main and refuses one red only with the item [V4,B3,C7] clause 1', t => {
  const known = fixture(t);
  const cache = join(known.root, '.git/pullboard/main-red.json');
  writeFileSync(cache, JSON.stringify({ version: 1, entries: { [known.main]: { 'test/inherited.test.js': { result: 'red' } } } }), { mode: 0o600 });
  const result = cli(known, known.builder, 'submit', String(known.item));
  const proofLog = runFixtureGit(['rev-parse', '--git-path', 'pullboard-submit.log.proof.log'], { cwd: known.builder, env: known.env }).trim();
  const observed = result.status ? { cache: JSON.parse(readFileSync(cache, 'utf8')),
    parsed: failureSignatures({ isGreen: false, stages: [{ status: 1, output: readFileSync(proofLog, 'utf8') }] }, known.builder) } : null;
  assert.equal(result.status, 0, JSON.stringify({ response: result.stdout + result.stderr, observed }));
  const report = JSON.parse(result.stdout);
  assert.equal(report.gate.green, false, 'an inherited failure stays red in its receipt');
  assert.equal(report.gate.knownMainFailures.main, known.main);
  assert.deepEqual(report.gate.knownMainFailures.failures.map(({ file, name }) => ({ file, name })),
    [{ file: 'test/inherited.test.js', name: 'shared failure [G1]' }]);
  // The receipt keeps a display-only firstError the board record does not store: compare the stored fields.
  const stored = ({ main, failures }) => ({ main, failures: failures.map(({ file, name, item, signature }) => ({ file, name, item, signature })) });
  assert.deepEqual(stored(submittedProof(known).submissionProof.knownMainFailures), stored(report.gate.knownMainFailures));
  const changed = fixture(t, { candidate: source('shared failure [G1]') + source('new item failure [G1]').split('\n').slice(2).join('\n') });
  const refused = cli(changed, changed.builder, 'submit', String(changed.item));
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stdout).error.code, 'GATE_RED');
  assert.equal(submittedProof(changed), null, 'a new failure in an already-red file still prevents submit');
});

test('known main receipts preserve exact identities and refuse unsupported historical envelopes [V4,B3,H16]', () => {
  const failure = { file: 'test/one.test.js', name: 'one failure [V4]', signature: 'a'.repeat(64) };
  const main = 'b'.repeat(40);
  const proof = { version: 1, files: [failure.file], full: false, deferred: false, reason: '',
    knownMainFailures: { main, failures: [failure] } };
  assert.deepEqual(submissionProof(proof, KNOWN_MAIN_FAILURES_ENGINE).knownMainFailures, proof.knownMainFailures);
  assert.throws(() => submissionProof(proof, KNOWN_MAIN_FAILURES_ENGINE - 1), { code: 'SUBMISSION_PROOF' });
  const historical = { version: 1, files: [], full: true, deferred: false, reason: 'historical full gate' };
  assert.deepEqual(submissionProof(historical, KNOWN_MAIN_FAILURES_ENGINE - 1), historical);
  for (const bad of [{ main, failures: [] }, { main: 'unknown', failures: [failure] },
    { main, failures: [{ ...failure, file: '../outside.test.js' }] }, { main, failures: [{ ...failure, signature: null }] }]) {
    assert.throws(() => submissionProof({ ...proof, knownMainFailures: bad }), { code: 'SUBMISSION_PROOF' });
  }
  const compared = { main, files: [{ file: failure.file, result: 'red', failures: [failure] }] };
  assert.deepEqual(matchingMainFailures([failure], compared, main), proof.knownMainFailures);
  assert.equal(matchingMainFailures([failure], compared, 'c'.repeat(40)), null);
  assert.equal(matchingMainFailures([failure], { ...compared, unavailable: 'timeout' }, main), null);
  assert.equal(matchingMainFailures([failure], { main, files: [{ file: failure.file, result: 'red' }] }, main), null);
  assert.equal(matchingMainFailures([{ ...failure, name: 'different failure' }], compared, main), null);
  assert.equal(matchingMainFailures([{ ...failure, file: 'test/other.test.js' }], compared, main), null);
  assert.equal(matchingMainFailures([{ ...failure, signature: 'd'.repeat(64) }], compared, main), null);
  assert.equal(matchingMainFailures([failure], { main, files: [{ file: failure.file, result: 'red', failures: [failure, failure] }] }, main), null);
  assert.equal(matchingMainFailures([], compared, main), null, 'zero candidate cases cannot authorize a known main red');
  assert.equal(matchingMainFailures([failure], { main, files: [] }, main), null, 'an empty comparison proves no case');
  assert.equal(matchingMainFailures([failure], { main, files: [{ file: failure.file, result: 'red', failures: [] }] }, main), null,
    'a red process with zero matched cases is not a known main failure');
  assert.equal(matchingMainFailures([failure], { ...compared, unavailable: 'NO_TESTS_MATCHED' }, main), null);
  for (const file of ['../outside.test.js', '/tmp/outside.test.js', 'file:///tmp/outside.test.js', 'test/../outside.test.js']) {
    const unbound = { ...failure, file };
    assert.equal(matchingMainFailures([unbound], { main, files: [{ file, result: 'red', failures: [unbound] }] }, main), null,
      'matching unbound strings cannot establish a project test identity');
  }
});

test('repair links retain historical receipts and reject closed, stale or ambiguous repairs [V4,B3,H16]', async () => {
  const { KNOWN_MAIN_REWORKS_ENGINE } = await import('../../../../../packages/state/light.js');
  const row = { file: 'test/one.test.js', name: 'one failure [V4]', signature: 'a'.repeat(64) };
  const known = { main: 'b'.repeat(40), failures: [row] };
  const repair = { item_id: 7, item_status: 'claimed', item_title: 'Main red: one assertion',
    item_frozen: JSON.stringify({ check: "node packages/gate/src/io/run/tests.js './test/one.test.js'" }), item_check: 'node wrong.test.js' };
  const linked = linkKnownMainReworks(known, [repair], 1);
  assert.equal(linked.failures[0].item, 7);
  assert.doesNotThrow(() => requireKnownMainReworks(linked, [repair], 1));
  for (const items of [[], [{ ...repair, item_status: 'withdrawn' }], [{ ...repair, item_merged_commit: 'c'.repeat(40) }],
    [{ ...repair, item_frozen: JSON.stringify({ check: 'node test/other.test.js' }) }], [repair, { ...repair, item_id: 8 }]]) {
    assert.throws(() => requireKnownMainReworks(linked, items, 1), { code: 'SUBMISSION_PROOF' });
  }
  assert.throws(() => requireKnownMainReworks({ ...linked, failures: [{ ...linked.failures[0], item: 8 }] }, [repair], 1), { code: 'SUBMISSION_PROOF' });
  assert.equal(linkKnownMainReworks(known, [repair], 7), null, 'a submission cannot sponsor its own known failure');
  const proof = { version: 1, files: [row.file], full: false, deferred: false, reason: '', knownMainFailures: linked };
  assert.deepEqual(submissionProof(proof, KNOWN_MAIN_REWORKS_ENGINE).knownMainFailures, linked);
  assert.throws(() => submissionProof(proof, KNOWN_MAIN_FAILURES_ENGINE), { code: 'SUBMISSION_PROOF' });
  assert.throws(() => submissionProof({ ...proof, knownMainFailures: known }, KNOWN_MAIN_REWORKS_ENGINE), { code: 'SUBMISSION_PROOF' });
});

test('ordered submit refuses a closed repair and an old-engine linked envelope without changing item history [V4,B3,H16]', async t => {
  const at = '2026-10-28T00:00:00.000Z';
  const source = fixtureBoard(t, { clock: { now: () => new Date(at) } });
  source.executionEngineVersion = KNOWN_MAIN_FAILURES_ENGINE;
  store.register(source, { lane: 'coordinator', path: '/fixture/coordinator' });
  const agentId = store.register(source, { lane: 'web', path: '/fixture/web' });
  const item = store.addItem(source, { by: 'coordinator', lane: 'web', title: 'Ordered repair-link fixture' });
  const repair = store.addItem(source, { by: 'coordinator', lane: 'web', title: 'Main red: one assertion',
    check: 'node --test test/one.test.js' });
  store.claim(source, item, { agentId, lane: 'web', leaseMs: 3600000,
    freeze: () => ({ text: '{"rows":[]}', digest: 'f'.repeat(64) }) });
  delete source.executionEngineVersion;
  const known = { main: 'b'.repeat(40), failures: [{ file: 'test/one.test.js', name: 'synthetic ordered failure [V4]',
    signature: 'a'.repeat(64), item: repair }] };
  // This is a board-protocol fixture, not an assertion that an executable gate ran.
  const options = { agentId, commit: 'c'.repeat(40), tree: 'd'.repeat(40), submissionProof: {
    version: 1, files: ['test/one.test.js'], full: false, deferred: true,
    reason: 'synthetic ordered receipt; no execution claim', knownMainFailures: known } };
  const move = prepareEngineMove(source, 'submit', [item, options], { id: 'linked-repair-submit' });
  const replica = fixtureBoard(t, { clock: { now: () => new Date(at) } });
  importBoard(replica, exportBoard(source));
  const beforeDowngrade = exportBoard(replica);
  assert.throws(() => applyEngineMove(replica, { ...move, engine: KNOWN_MAIN_FAILURES_ENGINE }, { sequence: 1, at }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(replica), beforeDowngrade, 'a downgraded linked envelope changes no receipt or board rows');
  store.withdraw(source, repair, { agentId: 'coordinator', reason: 'closed after preparation' });
  const before = { item: store.getItem(source, item), events: store.events(source, { itemId: item }) };
  const result = applyEngineMove(source, move, { sequence: 1, at });
  assert.equal(result.error?.code, 'SUBMISSION_PROOF');
  assert.deepEqual({ item: store.getItem(source, item), events: store.events(source, { itemId: item }) }, before);
  assert.deepEqual(applyEngineMove(source, move, { sequence: 1, at }), result, 'duplicate replay retains the recorded refusal');
  const historical = { ...move, id: 'historical-unlinked-submit', engine: KNOWN_MAIN_FAILURES_ENGINE,
    args: [item, { ...options, submissionProof: { ...options.submissionProof,
      knownMainFailures: { main: known.main, failures: known.failures.map(({ item: ignored, ...row }) => row) } } }] };
  const replayed = applyEngineMove(replica, historical, { sequence: 1, at });
  assert.equal(replayed.error, undefined, JSON.stringify(replayed));
  assert.equal(store.getItem(replica, item).item_status, 'submitted');
  const event = store.events(replica, { itemId: item }).find(row => row.event_kind === 'submit');
  assert.deepEqual(JSON.parse(event.event_detail).submissionProof.knownMainFailures, historical.args[1].submissionProof.knownMainFailures,
    'historical engine-124 replay neither adds repair ownership nor rewrites its receipt');
});

// #1986 accepts exact unowned main reds while retaining their durable accounting.
test('an exact unowned main red submits with its receipt, fact and decision shout [V4,B3]', t => {
  const box = fixture(t, { mainRed: false });
  const accepted = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  const report = JSON.parse(accepted.stdout);
  assert.equal(report.gate.green, false, 'the exact inherited failure remains visibly red');
  assert.deepEqual(report.gate.knownMainUnowned, [{ file: 'test/inherited.test.js', name: 'shared failure [G1]' }]);
  assert.equal(report.gate.knownMainReworks, undefined, 'no repair ownership is invented');
  assert.ok(submittedProof(box), 'the successful response has a canonical submitted event');
  const shown = cli(box, box.root, 'show', String(box.item));
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  assert.ok(JSON.parse(shown.stdout).thread.some(entry => entry.type === 'fact'
    && entry.text.includes('unowned known main red: the submission proof')
    && entry.text.includes(box.main) && entry.text.includes('test/inherited.test.js')
    && entry.text.includes('shared failure [G1]')), 'the durable fact identifies the exact main source, file and case');
  const db = new DatabaseSync(join(box.root, '.git/pullboard/board.sqlite'), { readOnly: true });
  try {
    const asked = db.prepare('SELECT * FROM shout').all().filter(row => row.shout_to === 'coordinator'
      && row.shout_decision === 1 && String(row.shout_text).includes(`#${box.item}: known main red`));
    assert.equal(asked.length, 1, 'exactly one decision reaches the coordinator');
    assert.ok(asked[0].shout_text.includes('test/inherited.test.js')
      && asked[0].shout_text.includes('shared failure [G1]')
      && asked[0].shout_text.includes(box.main.slice(0, 12)), 'the decision names the exact main failure');
  } finally { db.close(); }
});

test('a long infra note submits with one bounded automatic shout [V4,B3]', t => {
  const box = fixture(t, { mainRed: false });
  const note = 'a'.repeat(2000);
  const result = cli(box, box.builder, 'submit', String(box.item), '--infra', note, '--no-next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(submittedProof(box));
  const db = new DatabaseSync(join(box.root, '.git/pullboard/board.sqlite'), { readOnly: true });
  try {
    const shouts = db.prepare('SELECT * FROM shout').all().filter(row => row.shout_to === 'coordinator'
      && row.shout_decision === 1 && String(row.shout_text).includes(`#${box.item}: known main red`));
    assert.equal(shouts.length, 1);
    assert.ok(Array.from(shouts[0].shout_text).length <= 400);
    assert.match(shouts[0].shout_text, new RegExp(`pullboard show ${box.item}`));
  } finally { db.close(); }
});

test('an oversized main red decision preserves the show pointer [V4,B3]', async () => {
  const text = boundedMainRedShout(7, [{ file: 'test/red.test.js', names: ['🧪'.repeat(2000)] }], 'a'.repeat(40));
  assert.ok(Array.from(text).length <= 400);
  assert.match(text, /pullboard show 7/);
});

test('an exact main red with an open repair retains its reviewer repair link [V4,B3]', t => {
  const box = fixture(t);
  const accepted = cli(box, box.builder, 'submit', String(box.item));
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  const report = JSON.parse(accepted.stdout);
  assert.deepEqual(report.gate.knownMainReworks, [{ file: 'test/inherited.test.js', name: 'shared failure [G1]', item: box.rework }]);
  const shown = cli(box, box.root, 'show', String(box.item));
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  const facts = JSON.parse(shown.stdout).thread.filter(entry => entry.type === 'fact');
  assert.ok(facts.some(entry => entry.text.includes('test/inherited.test.js') && entry.text.includes('shared failure [G1]')
    && entry.text.includes(`#${box.rework}`)), 'the durable review thread links the exact known main red to its open repair');
});

test('submit refuses changed failure details, an unaccounted stage, and a frozen check red differently from main [V4,B3]', t => {
  for (const options of [
    // The check names the case's file, so it is the item's own and keeps the exact signature (neighbouring cases pass by name).
    { candidate: source('shared failure [G1]', 3), mainRed: false, check: 'node test/runner.js test/inherited.test.js' },
    { gateSuffix: '; exit 7' },
    { check: 'node test/runner.js', candidate: source('shared failure [G1]', 3), mainRed: false },
  ]) {
    const box = fixture(t, options);
    const result = cli(box, box.builder, 'submit', String(box.item));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).error.code, 'GATE_RED');
    assert.equal(submittedProof(box), null);
  }
});
