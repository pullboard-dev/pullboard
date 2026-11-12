/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js packages/state/src/io/machine.js */
import { recordFlakeObservation as nativeRecordFlakeObservation } from '../../../../packages/flakes/index.js';
import { digestNativePorts } from '../../tests/fixtures/ports.js';
/** Automatic Rigor proposals retain evidence, never invent proof or person approval [D1,D3,H16]. */
import { loadDoctrine } from '../../../../packages/doctrine/index.js';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { personNeedsState } from '../../../view/index.js';
import { resumeNeeds } from '../../../view/index.js';
import { resumeRigorCounters } from '../../../../packages/rigor/index.js';
import { RIGOR_COLD_NOTICE } from '../../../../packages/rigor/index.js';
import { clearProofCounters } from '../../../../packages/verify/index.js';
import { readDigest } from '../../../../packages/items/index.js';
import { healthReport } from '../../../../packages/health/index.js';
import { dispatchHealth } from '../../../../packages/sentinels/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import {
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { planAutomaticRigorApply } from '../../../../packages/rigor/index.js';
import {
  planRowApply,
  prepareRowDecisions,
  writeRowApply,
} from '../../../../packages/spec/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { RIGOR_AUTO_ENGINE } from '../../../../packages/state/light.js';
import {
  prepareEngineMove,
  applyEngineMove,
} from '../../../../packages/state/index.js';
import { conflictNote } from '../../../../packages/kernel/index.js';
import {
  automaticDecisionSource,
  rigorDecisionKey,
} from '../../../../packages/store/index.js';

const roots = [];
/** Bind real upper health providers for direct digest reads without changing their board snapshot. */
function digestHealth(options) {
  return healthReport({ ...options, dispatchHealth });
}
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** A real repository and private SQLite board; all failure receipts below are synthetic board fixtures. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-rigor-auto-'));
  roots.push(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Rigor fixture', GIT_AUTHOR_EMAIL: 'rigor@example.invalid',
    GIT_COMMITTER_NAME: 'Rigor fixture', GIT_COMMITTER_EMAIL: 'rigor@example.invalid',
    PULLBOARD_HOME: join(root, 'private-home'), PULLBOARD_MACHINE_HOME: join(root, 'private-machine') };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !key.startsWith('GIT_CONFIG_')
    && !key.startsWith('GIT_AUTHOR_') && !key.startsWith('GIT_COMMITTER_')) delete env[key];
  /** Run Git only inside this private fixture. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env, encoding: 'utf8' });
  /** Invoke only this checkout's CLI against the private fixture board. */
  const run = (...args) => runCliInProcess(args, { cwd: root, env });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ name: 'Rigor fixture', gate: 'true', spec: 'SPEC.md',
    lanes: { app: { owns: ['src/'] } }, landing: { cadence: '1h' } }));
  writeFileSync(join(root, 'SPEC.md'), '# Spec\n\n## G · Goals\n- G1 [approved, must] Keep the product coherent. | gate: review\n');
  writeFileSync(join(root, 'DOCTRINE.md'), '# Doctrine\n\n## DR · Rulings\n');
  git('add', '.'); git('commit', '-q', '-m', 'chore: prepare isolated Rigor fixture');
  const policy = { version: 1, commit: git('rev-parse', 'HEAD').trim(), verify: { policy: 'any', family: 'off' } };
  const directory = join(root, '.git', 'pullboard');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'board.sqlite');
  let now = new Date('2026-10-24T12:00:00Z');
  const board = openBoard(file, { now: () => new Date(now) }, { gitRoot: root });
  store.board_ensureCoordinator(board, root);
  const builder = store.register(board, { lane: 'app', path: join(root, 'builder'), model: 'Fixture builder' });
  const reviewer = store.register(board, { lane: 'app', path: join(root, 'reviewer'), model: 'Fixture reviewer' });
  let serial = 0;
  /** Add and submit a distinct synthetic commit through the normal board moves. */
  const submit = (title, beforeSubmit) => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'app', title });
    store.claim(board, id, { agentId: builder, lane: 'app', leaseMs: 7_200_000,
      freeze: item => ({ text: JSON.stringify({ criterion: item.item_title, policy }), digest: `fixture:${item.item_title}` }) });
    beforeSubmit?.(id);
    const commit = (++serial).toString(16).padStart(40, '0');
    submitFixture(board, id, { agentId: builder, commit, tree: 'e'.repeat(40) });
    return id;
  };
  /** Record an unclassified original failure, with no claim that this fixture executed a test. */
  const failure = (id, name = 'the same behavior fails') => nativeRecordFlakeObservation(board, { agentId: reviewer,
    lane: 'app', observation: { id: `fixture-${serial}`, head: store.getItem(board, id).item_commit,
      tree: 'e'.repeat(40), main: null, kind: 'verify', classification: 'unclassified',
      commandSha256: 'a'.repeat(64), reason: 'synthetic original failure; no gate execution', at: now.toISOString(),
      diagnosticMs: 0, load: { average: [0, 0, 0], cpus: 1, freeMB: 1 },
      file: 'test/example.test.js', name, paired: null, mainReceipt: null,
      original: { green: false, sha256: 'b'.repeat(64), bytes: 0,
        artifact: `flake-evidence/fixture-${serial}/original.log`, profileSha256: null } } });
  /** Reject with an optional explicit key, never deriving evidence from the prose note. */
  const reject = (id, options = {}) => store.verify(board, id, { agentId: reviewer, decision: 'REJECT',
    reason: 'TEST_FAILURE', note: 'synthetic failure receipt', clause: store.getItem(board, id).item_title, head: store.getItem(board, id).item_commit,
    digest: store.getItem(board, id).item_frozen_digest, policy: 'any', ...options });
  return { root, file, board, git, runLocal: run, submit, failure, reject,
    advance: ms => { now = new Date(now.getTime() + ms); }, close: () => store.closeBoard(board) };
}

test('a repeated cause becomes a coordinator proposal with no command run [D1,D3,S1,N19]', () => {
  const box = fixture();
  try {
    const before = ['SPEC.md', 'DOCTRINE.md', 'pullboard.json'].map(file => readFileSync(join(box.root, file), 'utf8'));
    const one = box.submit('First test failure'); box.failure(one); box.reject(one);
    assert.equal(JSON.parse(store.events(box.board, { itemId: one }).findLast(event => event.event_kind === 'reject').event_detail).cause,
      'test:test/example.test.js::the same behavior fails');
    assert.equal(store.rowDrafts(box.board).length, 0, 'one occurrence is not a repeat');
    const two = box.submit('Second test failure'); box.failure(two); box.reject(two);
    const proposals = store.rowDrafts(box.board);
    assert.ok(proposals.length > 0, 'the second reject itself creates a durable proposal');
    assert.ok(proposals.every(row => !row.written && row.gate === 'review'), 'no automatic approval or file application');
    const needs = personNeedsState(box.root, { board: box.board }).rigorDrafts.filter(need => need.kind === 'rigor-draft');
    assert.ok(needs.length > 0, 'the coordinator sees the board-only proposal immediately');
    assert.ok(needs.every(need => need.unproved === true && need.proof == null));
    assert.ok(needs.some(need => need.evidence.items.map(item => item.id).join(',') === `${one},${two}`));

    const coordinator = resumeNeeds(box.root, { board: box.board, config: loadConfig(box.root), includeRigorUndrafted: true });
    assert.ok(coordinator.rigorUndrafted.every(cause => !needs.some(need => need.cause === cause.key)),
      'an automatically drafted repeat is not also listed as undrafted advice [N19]');
    const options = { person: store.PERSON, drafts: store.rowDrafts(box.board), decisions: store.rowDecisions(box.board) };
    const hot = resumeRigorCounters(box.board, coordinator, options);
    assert.deepEqual(hot.causes, coordinator.rigorUndrafted);
    assert.equal(hot.notice, null);
    const nativeEvents = store.events(box.board).length;
    clearProofCounters(box.board);
    const cold = resumeRigorCounters(box.board, coordinator, options);
    assert.deepEqual(cold.causes, hot.causes, 'cold compatibility applies the same automatic-draft suppression');
    assert.equal(cold.notice, RIGOR_COLD_NOTICE);
    assert.equal(store.events(box.board).length, nativeEvents, 'cold compatibility never writes a native move');

    for (const title of ['First merge collision', 'Second merge collision']) {
      const id = box.submit(title);
      store.reopen(box.board, id, { agentId: 'coordinator', conflict: { files: ['src/shared.js'], trunk: 'd'.repeat(40) } });
      const event = store.events(box.board, { itemId: id }).findLast(entry => entry.event_kind === 'reopen');
      assert.equal(JSON.parse(event.event_detail).cause, 'conflict:src/shared.js');
    }
    const split = personNeedsState(box.root, { board: box.board }).rigorDrafts.find(need => need.cause === 'conflict:src/shared.js');
    assert.ok(split?.unproved, 'the second merge reopen creates architectural advice for the coordinator');
    assert.match(split.text, /splitting/iu);
    assert.deepEqual(['SPEC.md', 'DOCTRINE.md', 'pullboard.json'].map(file => readFileSync(join(box.root, file), 'utf8')), before);
    assert.equal(box.git('status', '--porcelain').trim(), '', 'the original moves leave the main checkout clean');
    assert.ok(store.allShouts(box.board).filter(shout => shout.shout_from === 'rigor').every(shout => !shout.shout_text.includes('Next: pullboard rigor draft')),
      'automatic shouts are receipts, not remembered-command requests');
  } finally { box.close(); }
});

test('Rigor keeps explicit keys, ignores stale failures and does not duplicate a pending draft [D1,H16]', () => {
  const box = fixture();
  try {
    const first = box.submit('Explicit key'); box.failure(first); box.reject(first, { cause: 'row:G1' });
    assert.equal(JSON.parse(store.events(box.board, { itemId: first }).findLast(event => event.event_kind === 'reject').event_detail).cause, 'row:G1');
    const second = box.submit('No current failure'); box.reject(second);
    assert.equal(JSON.parse(store.events(box.board, { itemId: second }).findLast(event => event.event_kind === 'reject').event_detail).cause, 'refusal:TEST_FAILURE');
    const third = box.submit('Same coded reason'); box.reject(third);
    const count = store.rowDrafts(box.board).length;
    const fourth = box.submit('One more coded reason'); box.reject(fourth);
    assert.equal(store.rowDrafts(box.board).length, count, 'a pending proposal stays one person call');
    assert.ok(count > 0);
    assert.equal(store.listItems(box.board, { all: true }).filter(item => item.item_status === 'verified').length, 0);
  } finally { box.close(); }
});

test('an unanswered Rigor draft is restated once in each read-only digest after the board cadence [D1,A2]', () => {
  const box = fixture();
  try {
    for (const title of ['First', 'Second']) { const id = box.submit(title); box.reject(id); }
    box.advance(3_600_001);
    const before = store.events(box.board).length;
    const digest = readDigest(box.file, { root: box.root, now: box.board.clock.now(), healthReport: digestHealth }, digestNativePorts);
    assert.match(digest.markdown, /Unanswered Rigor drafts/u);
    const ids = store.rowDrafts(box.board).map(row => row.id);
    for (const id of ids) assert.equal(digest.markdown.split(`Rigor draft ${id}:`).length - 1, 1);
    assert.equal(store.events(box.board).length, before, 'reading a digest records no reminder move');
  } finally { box.close(); }
});

test('materialized Rigor advice uses the existing person decision and a decline covers every preceding item [D1,B26,S1]', () => {
  const box = fixture();
  try {
    for (const title of ['First', 'Second', 'Third before decline']) { const id = box.submit(title); box.reject(id); }
    const [draft] = store.rowDrafts(box.board);
    const ref = `doctrine:${draft.id}`;
    const config = loadConfig(box.root);
    assert.throws(() => prepareRowDecisions(box.root, config, { ids: [ref], decision: 'decline', reason: 'not the right remedy' }, { loadDoctrine }),
      error => error.code === 'NO_ROW', 'a board-only proposal cannot bypass the existing exact-file person decision');
    const need = personNeedsState(box.root, { board: box.board }).rigorDrafts.find(entry => entry.id === ref);
    assert.equal(need.materialized, false);
    assert.equal(personNeedsState(box.root, { board: box.board }).needs.some(entry => entry.id === ref), false, 'coordinator preparation is not a person call');
    assert.match(need.what, /materialize/u);
    writeRowApply(box.root, planAutomaticRigorApply(box.root, config, store.rowDrafts(box.board)));
    assert.deepEqual(planAutomaticRigorApply(box.root, config, store.rowDrafts(box.board)).files, [], 'materialization is idempotent');
    assert.equal(personNeedsState(box.root, { board: box.board }).needs.find(entry => entry.id === ref).materialized, true);
    const records = prepareRowDecisions(box.root, config, { ids: [ref], decision: 'decline', reason: 'not the right remedy', on: box.board.clock.now().toISOString() }, { loadDoctrine });
    store.recordRowDecisions(box.board, { agentId: store.PERSON, channel: 'terminal', decisions: records });
    assert.equal(personNeedsState(box.root, { board: box.board }).rigorDrafts.some(entry => entry.id === ref), false);
    const fourth = box.submit('New item after decline'); box.reject(fourth);
    assert.equal(store.rowDrafts(box.board).length, 1, 'a declined key is not drafted again for a new item (GitHub #26)');
  } finally { box.close(); }
});

test('rigor.autoDraft false stops unproved auto-drafts and a bad value is refused (GH #26) [D1,S1]', () => {
  const box = fixture();
  try {
    const file = join(box.root, 'pullboard.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...config, rigor: { autoDraft: false } }));
    for (const title of ['First', 'Second', 'Third']) { const id = box.submit(title); box.failure(id); box.reject(id); }
    assert.equal(store.rowDrafts(box.board).length, 0, 'repeated failures draft nothing while autoDraft is false');
    assert.equal(store.events(box.board).some(event => event.event_kind === 'rigor-draft'), false);
    writeFileSync(file, JSON.stringify({ ...config, rigor: { autoDraft: true } }));
    const again = box.submit('Fourth'); box.failure(again); box.reject(again);
    assert.ok(store.rowDrafts(box.board).length > 0, 'turning it back on drafts again');
    writeFileSync(file, JSON.stringify({ ...config, rigor: { autoDraft: 'no' } }));
    assert.throws(() => loadConfig(box.root), error => error.code === 'BAD_CONFIG' && /autoDraft/u.test(error.message));
  } finally { box.close(); }
});

test('a cross-file row collision stays visible and refuses before any automatic proposal is materialized [D1,S1]', () => {
  const box = fixture();
  try {
    for (const title of ['First', 'Second']) { const id = box.submit(title); box.failure(id); box.reject(id); }
    const draft = store.rowDrafts(box.board).find(row => row.target === 'doctrine');
    const spec = join(box.root, 'SPEC.md');
    writeFileSync(spec, readFileSync(spec, 'utf8') + `- ${draft.id} [approved, aim] ${draft.text} | gate: a different gate\n`);
    const before = ['SPEC.md', 'DOCTRINE.md'].map(file => readFileSync(join(box.root, file), 'utf8'));
    assert.throws(() => planAutomaticRigorApply(box.root, loadConfig(box.root), store.rowDrafts(box.board)),
      error => error.code === 'ROW_DRAFT' && /collision/u.test(error.message));
    assert.deepEqual(['SPEC.md', 'DOCTRINE.md'].map(file => readFileSync(join(box.root, file), 'utf8')), before);
    assert.equal(personNeedsState(box.root, { board: box.board }).rigorDrafts.find(need => need.id === `doctrine:${draft.id}`).collision, true);
  } finally { box.close(); }
});

test('a person can replace automatic advice without breaking a later spec apply [D1,B26,S1]', () => {
  const box = fixture();
  try {
    for (const title of ['First', 'Second']) { const id = box.submit(title); box.reject(id); }
    const config = loadConfig(box.root);
    const drafts = store.rowDrafts(box.board);
    writeRowApply(box.root, planAutomaticRigorApply(box.root, config, drafts));
    const records = prepareRowDecisions(box.root, config, { ids: [`doctrine:${drafts[0].id}`], decision: 'approve',
      text: 'The person chooses a different remedy.', on: box.board.clock.now().toISOString() }, { loadDoctrine });
    store.recordRowDecisions(box.board, { agentId: store.PERSON, channel: 'terminal', decisions: records });
    const plan = planRowApply(box.root, config, store.rowDecisions(box.board), undefined, { loadDoctrine });
    writeRowApply(box.root, plan);
    store.applyRowDecisions(box.board, { agentId: 'coordinator', events: plan.records.map(record => record.event) });
    assert.deepEqual(planAutomaticRigorApply(box.root, config, drafts, store.rowDecisions(box.board)).files, []);
    assert.match(readFileSync(join(box.root, 'DOCTRINE.md'), 'utf8'), /\[approved, aim\] The person chooses a different remedy\./u);
    assert.equal(personNeedsState(box.root, { board: box.board }).rigorDrafts.some(need => need.kind === 'rigor-draft'), false);
    const doctrine = join(box.root, 'DOCTRINE.md');
    writeFileSync(doctrine, readFileSync(doctrine, 'utf8').replace(' | gate: review', ' | gate: a changed gate'));
    assert.equal(personNeedsState(box.root, { board: box.board }).rigorDrafts.find(need => need.id === `doctrine:${drafts[0].id}`).collision, true,
      'a later edit cannot hide behind the old person decision');
    assert.throws(() => planAutomaticRigorApply(box.root, config, drafts, store.rowDecisions(box.board)), error => error.code === 'ROW_DRAFT');
    box.advance(3_600_001);
    assert.ok(readDigest(box.file, { root: box.root, now: box.board.clock.now(), healthReport: digestHealth }, digestNativePorts).markdown.includes(`Rigor draft ${drafts[0].id}:`),
      'the overdue digest also retains a proposal whose old decision is stale');
  } finally { box.close(); }
});

test('a stale person decision refuses spec apply before any unrelated automatic draft is written [D1,B26,S1]', async () => {
  const box = fixture();
  try {
    const config = loadConfig(box.root);
    const records = prepareRowDecisions(box.root, config, { ids: ['G1'], decision: 'approve', on: box.board.clock.now().toISOString() }, { loadDoctrine });
    store.recordRowDecisions(box.board, { agentId: store.PERSON, channel: 'terminal', decisions: records });
    const spec = join(box.root, 'SPEC.md');
    writeFileSync(spec, readFileSync(spec, 'utf8').replace('Keep the product coherent.', 'Changed after the decision.'));
    for (const title of ['First', 'Second']) { const id = box.submit(title); box.reject(id); }
    const before = ['SPEC.md', 'DOCTRINE.md'].map(file => readFileSync(join(box.root, file), 'utf8'));
    const applied = await box.runLocal('spec', 'apply', '--json');
    assert.equal(applied.status, 1, applied.stdout + applied.stderr);
    assert.equal(JSON.parse(applied.stdout).error.code, 'STALE_ROW_DECISION');
    assert.deepEqual(['SPEC.md', 'DOCTRINE.md'].map(file => readFileSync(join(box.root, file), 'utf8')), before);
  } finally { box.close(); }
});

test('declining a never-again proposal stays quiet for the same item and records no invented proof [D1,B26]', () => {
  const box = fixture();
  try {
    const id = box.submit('A person-marked responsibility');
    /** Record the person's explicit never-again move on this private board. */
    const mark = () => store.appendFact(box.board, id, { agentId: 'coordinator', kind: 'root-cause', text: 'Do not repeat this',
      cause: 'doctrine:C3', neverAgain: true, asPerson: true, channel: 'terminal' });
    mark();
    const drafts = store.rowDrafts(box.board);
    assert.equal(drafts.length, 1);
    const need = personNeedsState(box.root, { board: box.board }).rigorDrafts.find(entry => entry.kind === 'rigor-draft');
    assert.equal(need.evidence.occurrences, 0);
    assert.equal(need.proof, null);
    const config = loadConfig(box.root);
    writeRowApply(box.root, planAutomaticRigorApply(box.root, config, drafts));
    const records = prepareRowDecisions(box.root, config, { ids: [`doctrine:${drafts[0].id}`], decision: 'decline',
      reason: 'No new rule is needed.', on: box.board.clock.now().toISOString() }, { loadDoctrine });
    store.recordRowDecisions(box.board, { agentId: store.PERSON, channel: 'terminal', decisions: records });
    mark();
    assert.equal(store.rowDrafts(box.board).length, 1);
    assert.equal(personNeedsState(box.root, { board: box.board }).rigorDrafts.some(entry => entry.kind === 'rigor-draft'), false);
  } finally { box.close(); }
});

test('old ordered rejects replay without new causes or automatic drafts [D1,H16]', () => {
  const box = fixture();
  try {
    const id = box.submit('Old reject');
    const item = store.getItem(box.board, id);
    const move = prepareEngineMove(box.board, 'verify', [id, { agentId: 'app-2', decision: 'REJECT',
      reason: 'TEST_FAILURE', note: 'old coded verdict', head: item.item_commit, digest: item.item_frozen_digest, policy: 'any' }]);
    move.engine = RIGOR_AUTO_ENGINE - 1;
    const outcome = applyEngineMove(box.board, move, { sequence: 1, at: box.board.clock.now().toISOString() });
    assert.equal(outcome.error, undefined, JSON.stringify(outcome.error));
    const event = store.events(box.board, { itemId: id }).findLast(entry => entry.event_kind === 'reject');
    assert.equal(Object.hasOwn(JSON.parse(event.event_detail), 'cause'), false);
    assert.equal(store.rowDrafts(box.board).length, 0);
  } finally { box.close(); }
});

test('merge path identity survives spaces and line breaks without turning advice into a code rule [D1,C7]', () => {
  const box = fixture();
  try {
    const path = 'src/a b|c\n.js';
    for (const title of ['First conflict', 'Second conflict']) {
      const id = box.submit(title);
      store.reopen(box.board, id, { agentId: 'coordinator', conflict: { files: [path], trunk: 'd'.repeat(40) } });
      const event = store.events(box.board, { itemId: id }).findLast(entry => entry.event_kind === 'reopen');
      const detail = JSON.parse(event.event_detail);
      assert.equal(detail.cause, `conflict:${encodeURI(path)}`);
      assert.deepEqual(detail.causeDerivation.files, [path]);
    }
    const drafts = store.rowDrafts(box.board);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].target, 'doctrine');
    assert.equal(drafts[0].gate, 'review');
    writeRowApply(box.root, planAutomaticRigorApply(box.root, loadConfig(box.root), drafts));
    assert.equal(personNeedsState(box.root, { board: box.board }).needs.find(entry => entry.kind === 'rigor-draft').materialized, true);
  } finally { box.close(); }
});

test('canonical conflict holds crossing the hot-file threshold also draft advice without a command [D1,C7]', () => {
  const box = fixture();
  try {
    for (const title of ['First held item', 'Second held item', 'Third held item']) {
      const id = store.addItem(box.board, { by: 'coordinator', lane: 'app', title });
      store.holdItem(box.board, id, { agentId: 'coordinator', reason: conflictNote({ files: ['src/shared.js'], trunk: 'd'.repeat(40) }) });
    }
    assert.equal(store.rowDrafts(box.board).length, 1, 'the third hold does not duplicate pending advice');
    const need = personNeedsState(box.root, { board: box.board }).rigorDrafts.find(entry => entry.kind === 'rigor-draft');
    assert.equal(need.cause, 'conflict:src/shared.js');
    assert.equal(need.unproved, true);
    assert.equal(box.git('status', '--porcelain').trim(), '', 'the automatic holds do not edit the repository');
  } finally { box.close(); }
});

/** Unsupported historical grammar carries no authority; unrelated reader failures must remain visible. */
test('automatic decision readers ignore only unsupported historical grammar [D1,H16,M1]', () => {
  const source = '<!-- pullboard-grammar 999 -->\n- G9 [draft, aim] Historical proposal | gate: review';
  assert.equal(automaticDecisionSource({ source }), null);
  assert.equal(rigorDecisionKey({ source }), null);
  const broken = { get source() { throw new Error('unexpected metadata reader failure'); } };
  assert.throws(() => automaticDecisionSource(broken), /unexpected metadata reader failure/);
  assert.throws(() => rigorDecisionKey(broken), /unexpected metadata reader failure/);
});

/** Conditional unholds must not replace the failure event delivered to automatic Rigor. */
test('conditional reject and reopen holds retain their exact Rigor threshold triggers [B4,H16,D3]', async t => {
  for (const kind of ['reject', 'reopen']) {
    await t.test(kind, () => {
      const box = fixture();
      try {
        const ids = [];
        for (let index = 0; index < 2; index += 1) {
          const id = box.submit(`Conditional ${kind} ${index}`, held => {
            store.holdItem(box.board, held, { agentId: 'coordinator', reason: 'Await this native failure', until: kind });
          });
          ids.push(id);
          if (kind === 'reject') {
            box.failure(id);
            box.reject(id);
          } else {
            store.reopen(box.board, id, { agentId: 'coordinator', conflict: { files: ['src/shared.js'], trunk: 'd'.repeat(40) } });
          }
          const events = store.events(box.board, { itemId: id });
          const trigger = events.findLast(event => event.event_kind === kind);
          const lifts = events.filter(event => event.event_kind === 'unhold_item');
          assert.equal(lifts.length, 1);
          assert.equal(JSON.parse(lifts[0].event_detail).triggerEventId, trigger.event_id);
          assert.ok(lifts[0].event_id > trigger.event_id);
          assert.equal(store.itemHold(box.board, id), null);
          assert.equal(box.board.lastEvent.event_id, store.events(box.board).at(-1).event_id,
            'latest native event remains the actual final append');
          if (index === 0) assert.equal(store.rowDrafts(box.board).length, 0);
        }
        const needs = personNeedsState(box.root, { board: box.board }).rigorDrafts;
        const cause = kind === 'reject' ? 'test:test/example.test.js::the same behavior fails' : 'conflict:src/shared.js';
        const proposal = needs.find(need => need.cause === cause);
        assert.ok(proposal?.unproved, 'the second actual failure creates the existing Rigor proposal');
        assert.deepEqual(proposal.evidence.items.map(item => item.id), ids);
      } finally { box.close(); }
    });
  }
});
